/**
 * srv/lib/reconcile.js
 *
 * Cross-field reconciliation and failure diagnosis for extracted invoices.
 *
 * Deliberately dependency-free: no CAP, no HTTP, no Claude. Pure functions over
 * the extraction response. That means it is unit-testable without a server, and
 * it can never accidentally cost money.
 *
 * WHAT THIS IS FOR
 *
 * Per-field confidence catches "Doc AI wasn't sure". It cannot catch errors
 * where every field is individually correct but they disagree with each other:
 *
 *   - 106 line rows extracted perfectly, summing to 26,013.53 less than the
 *     total printed on the document
 *   - city "Katy" and postal code "77002" both valid, from different blocks
 *   - a check that compares the line sum against a number derived from the
 *     line sum, and therefore can never fail
 *
 * Those are the errors that reach production.
 */

'use strict'

// ---------------------------------------------------------------------------
// Failure taxonomy -- what KIND of problem is this, and what could fix it
// ---------------------------------------------------------------------------

const FAILURE = {
  EXTRACTION_SHORTFALL:  'EXTRACTION_SHORTFALL',
  EXTRACTION_OVERCOUNT:  'EXTRACTION_OVERCOUNT',  // extracted > printed; rollup/subtotal rows
  ZERO_VALUE_ROWS:       'ZERO_VALUE_ROWS',
  MISSING:               'MISSING',
  FIELD_CONFUSION:       'FIELD_CONFUSION',
  MIXED_PROVENANCE:      'MIXED_PROVENANCE',
  FORMAT:                'FORMAT',
  OCR_MISREAD:           'OCR_MISREAD',
  ENGINE_UNAVAILABLE:    'ENGINE_UNAVAILABLE',
  // The same amount is reachable from a line-item sum AND a header field; they were
  // resolved by precedence (line wins for freight, header wins for tax) but disagreed
  // by more than tolerance.  Likely page-scope duplication or a multi-block invoice.
  AMOUNT_SOURCE_CONFLICT: 'AMOUNT_SOURCE_CONFLICT'
}

/**
 * Which layer can ACTUALLY resolve each failure. Not cheapest-first --
 * capable-first. A text audit cannot resolve a layout question no matter how
 * cheap it is, because the information is not in the text.
 */
const REMEDY = {
  [FAILURE.EXTRACTION_SHORTFALL]: 'vision',   // re-read the amounts column
  [FAILURE.EXTRACTION_OVERCOUNT]: 'vision',   // subtotal vs line item is a layout question
  [FAILURE.ZERO_VALUE_ROWS]:      'vision',   // is it really 0, or unread?
  [FAILURE.MISSING]:              'vision',   // present or genuinely absent?
  [FAILURE.FIELD_CONFUSION]:      'vision',   // which block is which
  [FAILURE.MIXED_PROVENANCE]:     'vision',   // spatial question
  [FAILURE.FORMAT]:               'repair',   // free
  [FAILURE.OCR_MISREAD]:          'text',     // context resolves it
  [FAILURE.ENGINE_UNAVAILABLE]:    'none',     // not a document problem
  [FAILURE.AMOUNT_SOURCE_CONFLICT]: 'docai'   // re-extract or tighten page-scope to remove duplication
}

const TOLERANCE_PCT = 0.005          // 0.5% -- rounding, not missing rows
const ZERO_ROW_WARN_RATIO = 0.05     // >5% of rows at zero is suspicious

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num (v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isNaN(n) ? null : n
}

function pct (a, b) {
  return b ? Math.abs(a / b) : 0
}

/** ZIP prefix -> state. Enough to catch a ZIP that cannot belong to the state. */
const ZIP_STATE_RANGES = [
  [[995, 999], 'AK'], [[350, 352], 'AL'], [[354, 369], 'AL'], [[716, 729], 'AR'],
  [[850, 865], 'AZ'], [[900, 961], 'CA'], [[800, 816], 'CO'], [[60, 69], 'CT'],
  [[200, 205], 'DC'], [[197, 199], 'DE'], [[320, 349], 'FL'], [[300, 319], 'GA'],
  [[967, 968], 'HI'], [[500, 528], 'IA'], [[832, 838], 'ID'], [[600, 629], 'IL'],
  [[460, 479], 'IN'], [[660, 679], 'KS'], [[400, 427], 'KY'], [[700, 714], 'LA'],
  [[10, 27], 'MA'], [[206, 219], 'MD'], [[39, 49], 'ME'], [[480, 499], 'MI'],
  [[550, 567], 'MN'], [[630, 658], 'MO'], [[386, 397], 'MS'], [[590, 599], 'MT'],
  [[270, 289], 'NC'], [[580, 588], 'ND'], [[680, 693], 'NE'], [[30, 38], 'NH'],
  [[70, 89], 'NJ'], [[870, 884], 'NM'], [[889, 898], 'NV'], [[90, 149], 'NY'],
  [[430, 459], 'OH'], [[730, 749], 'OK'], [[970, 979], 'OR'], [[150, 196], 'PA'],
  [[28, 29], 'RI'], [[290, 299], 'SC'], [[570, 577], 'SD'], [[370, 385], 'TN'],
  [[750, 799], 'TX'], [[885, 885], 'TX'], [[840, 847], 'UT'],
  [[220, 246], 'VA'], [[50, 59], 'VT'], [[980, 994], 'WA'], [[530, 549], 'WI'],
  [[247, 268], 'WV'], [[820, 831], 'WY']
]

function stateForZip (zip) {
  const m = String(zip || '').match(/^(\d{3})/)
  if (!m) return null
  const p = parseInt(m[1], 10)
  for (const [[lo, hi], st] of ZIP_STATE_RANGES) {
    if (p >= lo && p <= hi) return st
  }
  return null
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * THE IMPORTANT ONE.
 *
 * Compares the extracted total against the total PRINTED ON THE DOCUMENT.
 *
 * Note what this does NOT do: compare against invoiceNetTotal alone. That
 * number is computed FROM the line rows, so the comparison would be an
 * arithmetic identity and always passes. A check that cannot fail is worse
 * than no check, because it produces false assurance.
 *
 * ── Printed total (reference) ─────────────────────────────────────────────
 *
 * Sourced in two passes so the check works across invoice modes:
 *
 *   Pass 1 — top-level pipeline properties (construction invoices):
 *             workCompletedThisPeriodTotal, grossAmount
 *
 *   Pass 2 — raw DocAI field values in r.fields[] (non-construction):
 *             grossAmount, totalAmountDue, invoiceTotalAmount
 *             This mirrors _computeSelfBalance (the UI "discrepancy" banner),
 *             which reads fields[grossAmount].docAIValue as its reference.
 *             Using the same source means the panel and the banner cannot
 *             disagree on which total triggered the mismatch.
 *
 * NOTE: invoiceTotalAmount is intentionally absent from the top-level pass.
 * In the pipeline it is always derived (= invoiceNetTotal + vendorTaxAmount),
 * so comparing it against the extracted total would be tautological and could
 * never catch missing rows.
 *
 * ── Extracted total ───────────────────────────────────────────────────────
 *
 * Mirrors _computeSelfBalance's LHS: net lines + freight + tax.
 * Using only invoiceNetTotal would produce a permanent false gap equal to
 * (freight + tax) on non-construction invoices even when every line was
 * extracted correctly.
 */

/** Top-level result properties set by the normalisation pipeline (construction). */
const PRINTED_TOTAL_TOP_KEYS = [
  'workCompletedThisPeriodTotal',  // AIA G702/G703 primary field
  'grossAmount'                    // pipeline alias; set from workCompletedThisPeriodTotal
]

/** Raw DocAI field names to try in r.fields[] (non-construction fallback). */
const PRINTED_TOTAL_FIELD_NAMES = [
  'grossAmount',        // most common non-construction total field
  'totalAmountDue',     // alternate name used by some vendors
  'invoiceTotalAmount'  // last resort; raw on some formats, derived on others
]

function checkExtractionCompleteness (r) {
  // ── Pass 1: top-level pipeline properties (construction) ──────────────────
  let printed = null, printedFrom = null
  for (const key of PRINTED_TOTAL_TOP_KEYS) {
    const v = num(r[key])
    if (v !== null) { printed = v; printedFrom = key; break }
  }

  // ── Pass 2: raw DocAI field values (non-construction fallback) ────────────
  // Same lookup as _computeSelfBalance / the UI "discrepancy" banner.
  if (printed === null) {
    for (const fieldName of PRINTED_TOTAL_FIELD_NAMES) {
      const f = (r.fields || []).find(f => f.fieldName === fieldName)
      const v = num(f ? (f.correctValue ?? f.docAIValue) : null)
      if (v !== null) { printed = v; printedFrom = `fields.${fieldName}`; break }
    }
  }

  // ── Extracted total: net + freight + tax ──────────────────────────────────
  const net     = num(r.invoiceNetTotal)
  const freight = num(r.invoiceFreightTotal) ?? 0
  const tax     = num(r.vendorTaxAmount)     ?? 0
  const extracted = net !== null ? +(net + freight + tax).toFixed(2) : null

  if (printed === null || extracted === null) {
    const missingParts = []
    if (printed === null)
      missingParts.push(
        `printed total (tried: ${PRINTED_TOTAL_TOP_KEYS.join(', ')}; ` +
        `fields[${PRINTED_TOTAL_FIELD_NAMES.join(', ')}])`
      )
    if (extracted === null) missingParts.push('invoiceNetTotal')
    return {
      name: 'extractedLinesReconcileToPrintedTotal',
      passed: null,
      severity: 'error',
      failureMode: null,
      suggestedLayer: null,
      message: 'Check skipped — input unavailable: ' + missingParts.join(', ') + '.',
      values: { printedTotal: printed, extractedTotal: extracted, printedFrom },
      provenance: '(none) vs invoiceNetTotal + invoiceFreightTotal + vendorTaxAmount'
    }
  }

  // gap > 0: under-extraction (rows missing or read as zero; taxable base understated)
  // gap < 0: over-extraction (rollup/subtotal rows counted alongside components)
  const gap    = +(printed - extracted).toFixed(2)
  const ratio  = pct(gap, printed)   // pct() applies Math.abs internally
  const ok     = ratio <= TOLERANCE_PCT
  const isOver = gap < 0

  const mode = isOver ? FAILURE.EXTRACTION_OVERCOUNT : FAILURE.EXTRACTION_SHORTFALL

  return {
    name: 'extractedLinesReconcileToPrintedTotal',
    passed: ok,
    severity: 'error',
    failureMode: ok ? null : mode,
    suggestedLayer: ok ? null : REMEDY[mode],
    message: ok
      ? `Extracted total (${extracted}) reconciles to the printed total ` +
        `(${printed} from ${printedFrom}).`
      : isOver
        ? `Extracted total ${extracted} exceeds the printed total ` +
          `${printed} (${printedFrom}). Over-extraction of ${Math.abs(gap)} ` +
          `(${(ratio * 100).toFixed(1)}%). Rollup or subtotal rows may be counted ` +
          `alongside their components, overstating the taxable base.`
        : `Extracted total ${extracted} is below the printed total ` +
          `${printed} (${printedFrom}). Gap of ${gap} ` +
          `(${(ratio * 100).toFixed(1)}%). Rows are missing or were read as zero, ` +
          `so the taxable base is understated.`,
    values: { printedTotal: printed, extractedTotal: extracted, gap, ratio, printedFrom },
    provenance: `${printedFrom} vs invoiceNetTotal + invoiceFreightTotal + vendorTaxAmount`
  }
}

/** Rows read as 0.00 are often unread rather than genuinely zero. */
function checkZeroValueRows (r) {
  const lines = r.keepLines || []
  if (!lines.length) return null

  const zeros = lines.filter(l => num(l.amount) === 0)
  const ratio = zeros.length / lines.length
  const ok = ratio <= ZERO_ROW_WARN_RATIO

  return {
    name: 'zeroValueRowRatio',
    passed: ok,
    severity: 'warning',
    failureMode: ok ? null : FAILURE.ZERO_VALUE_ROWS,
    suggestedLayer: ok ? null : REMEDY[FAILURE.ZERO_VALUE_ROWS],
    message: ok
      ? `${zeros.length} of ${lines.length} rows are zero-value.`
      : `${zeros.length} of ${lines.length} rows (${(ratio * 100).toFixed(0)}%) ` +
        `have a zero amount. Likely unread values rather than genuine zeros. ` +
        `Examples: ${zeros.slice(0, 4).map(l => l.description).join('; ')}`,
    values: { zeroCount: zeros.length, total: lines.length, ratio,
              examples: zeros.slice(0, 8).map(l => l.description) },
    provenance: 'keepLines[].amount'
  }
}

/**
 * Ship-to components assembled from DIFFERENT address blocks.
 *
 * This is what catches "Katy" + "77002" without needing a city database.
 * Each component individually looks fine; the problem is that they did not
 * come from the same block on the page. That is a spatial question, so only
 * vision can settle it.
 */
function checkAddressProvenance (r) {
  const parts = {
    city: r.shipToCity,
    postalCode: r.shipToPostalCode,
    state: r.shipToState
  }
  const sources = r._provenance?.shipTo || r.shipToProvenance || null
  const populated = Object.entries(parts).filter(([, v]) => v)

  if (populated.length < 2) return null

  // Cross-check ZIP against state -- catches the blatant cases with no dataset.
  const zipState = stateForZip(parts.postalCode)
  const stateMismatch = zipState && parts.state &&
                        zipState !== String(parts.state).toUpperCase()

  // Different provenance for different components is the subtler signal.
  const distinctSources = sources
    ? new Set(Object.values(sources).filter(Boolean))
    : new Set()
  const mixed = distinctSources.size > 1

  const ok = !stateMismatch && !mixed
  const mode = stateMismatch ? FAILURE.FIELD_CONFUSION
    : mixed ? FAILURE.MIXED_PROVENANCE : null

  return {
    name: 'shipToComponentsCoherent',
    passed: ok,
    severity: 'error',
    failureMode: mode,
    suggestedLayer: mode ? REMEDY[mode] : null,
    message: stateMismatch
      ? `Postal code ${parts.postalCode} belongs to ${zipState}, but state is ` +
        `${parts.state}. Jurisdiction is determined at postal-code level.`
      : mixed
        ? `Ship-to components came from different address blocks ` +
          `(${[...distinctSources].join(', ')}). Individually valid, but they ` +
          `may not describe the same location.`
        : `Ship-to components are coherent: ${parts.city} ${parts.postalCode} ` +
          `${parts.state}.`,
    values: { ...parts, zipImpliedState: zipState, sources },
    provenance: '_resolveShipTo'
  }
}

/**
 * Top-level equivalents for header fields that the normalisation pipeline
 * resolves from line items rather than reading directly from a header block.
 *
 * When a header field is empty but the resolved top-level value is populated,
 * the semantic value IS present for tax-calculation purposes — the check should
 * pass and the message should note where the value came from.
 */
const RESOLVED_EQUIVALENTS = {
  taxAmount:       { key: 'vendorTaxAmount', label: 'line-item tax resolution (vendorTaxAmount)' },
  taxAmountHeader: { key: 'vendorTaxAmount', label: 'line-item tax resolution (vendorTaxAmount)' },
  grossAmount:     { key: 'invoiceNetTotal', label: 'line-item sum (invoiceNetTotal)' }
}

/** Tax-critical fields that came back empty. */
function checkTaxCriticalPresence (r) {
  const fields = r.fields || []

  // Split empty tax-critical fields into two buckets:
  //   resolvedViaTopLevel — header empty, but the pipeline resolved the value
  //   missing             — header empty AND no resolved top-level equivalent
  const resolvedViaTopLevel = []
  const missing = []

  for (const f of fields) {
    if (f.taxCritical !== true) continue
    const emptyHeader =
      f.docAIValue === null || f.docAIValue === undefined ||
      String(f.docAIValue).trim() === ''
    if (!emptyHeader) continue

    const equiv  = RESOLVED_EQUIVALENTS[f.fieldName]
    const topVal = equiv ? r[equiv.key] : undefined
    const topPopulated =
      topVal !== null && topVal !== undefined && String(topVal).trim() !== ''

    if (equiv && topPopulated) {
      resolvedViaTopLevel.push({
        fieldName: f.fieldName,
        resolvedFrom: equiv.key,
        value: topVal,
        label: equiv.label
      })
    } else {
      missing.push(f.fieldName)
    }
  }

  const ok = missing.length === 0

  let message
  if (ok && resolvedViaTopLevel.length === 0) {
    message = 'All tax-critical fields have a value.'
  } else if (ok) {
    const notes = resolvedViaTopLevel
      .map(n => `${n.fieldName} header empty — resolved via ${n.label} (${n.value}).`)
      .join(' ')
    message = `All tax-critical fields present. ${notes}`
  } else {
    message =
      `${missing.length} tax-critical field(s) empty: ${missing.join(', ')}. ` +
      `Vision can distinguish "absent from the document" from "present but unread".`
    if (resolvedViaTopLevel.length > 0) {
      message +=
        ` (${resolvedViaTopLevel.map(n => `${n.fieldName} resolved via ${n.label}`).join(', ')})`
    }
  }

  return {
    name: 'taxCriticalFieldsPresent',
    passed: ok,
    severity: 'error',
    failureMode: ok ? null : FAILURE.MISSING,
    suggestedLayer: ok ? null : REMEDY[FAILURE.MISSING],
    message,
    values: {
      missing,
      resolvedFromTopLevel: resolvedViaTopLevel.map(n => n.fieldName)
    },
    provenance: 'fields[].taxCritical → top-level vendorTaxAmount / invoiceNetTotal'
  }
}

/** Is a tax engine actually connected? Affects what any verdict is worth. */
function checkEngineAvailability (r) {
  const engines = r.taxEngineResults || {}
  const available = Object.entries(engines)
    .filter(([, v]) => v && v.available === true)
    .map(([k]) => k)
  const ok = available.length > 0

  return {
    name: 'taxEngineAvailable',
    passed: ok,
    severity: 'warning',
    failureMode: ok ? null : FAILURE.ENGINE_UNAVAILABLE,
    suggestedLayer: ok ? null : REMEDY[FAILURE.ENGINE_UNAVAILABLE],
    message: ok
      ? `Tax engine available: ${available.join(', ')}.`
      : 'No tax engine connected. Any over/under-charged verdict is indicative ' +
        'only and must not be presented as authoritative.',
    values: { available },
    provenance: 'taxEngineResults'
  }
}

// ---------------------------------------------------------------------------
// Amount-source conflict check
// ---------------------------------------------------------------------------

/**
 * Detects when the same invoice amount was extracted from two independent
 * sources (a line-item sum and a document-level header field) and they
 * disagreed beyond tolerance.
 *
 * The extraction layer (resolveAmount in resolve-amount.js) already chose the
 * winning value by declared precedence; this check surfaces the conflict in
 * the reconciliation panel so a reviewer can confirm the chosen value is
 * correct and investigate whether multi-page or multi-block duplication is
 * the root cause.
 *
 * The check is SKIPPED (returns null) when no amountSources data is present
 * in the extraction (e.g., older cached results or test fixtures that pre-date
 * the resolve-amount migration).
 */
function checkAmountSourceConflict (extraction) {
  const sources = extraction.amountSources
  if (!sources || sources.length === 0) return null  // SKIPPED — no source data

  const conflicts = sources.filter(function(s) { return s && s.conflict })
  if (conflicts.length === 0) return null  // SKIPPED — both sources agree everywhere

  const messages = conflicts.map(function (s) {
    return s.label + ': line-items=' + s.lineTotal +
           ' vs header=' + s.headerAmt +
           ' (diff ' + s.diff + ', resolved using ' + s.source + ')'
  })

  return {
    name: 'amountSourceConflict',
    passed: false,
    severity: 'warning',
    message: 'Amount-source conflict detected: ' + messages.join('; ') + '. ' +
             'The extraction resolved each amount by precedence (line items over header for freight; ' +
             'header over lines for tax), but the disagreement suggests page-scope duplication ' +
             'or a multi-block invoice where the same charge appears on multiple pages. ' +
             'Verify the resolved value against the invoice image.',
    suggestedLayer: REMEDY[FAILURE.AMOUNT_SOURCE_CONFLICT],
    failures: [FAILURE.AMOUNT_SOURCE_CONFLICT]
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function reconcile (extraction) {
  const checks = [
    checkExtractionCompleteness(extraction),
    checkZeroValueRows(extraction),
    checkAddressProvenance(extraction),
    checkTaxCriticalPresence(extraction),
    checkEngineAvailability(extraction),
    checkAmountSourceConflict(extraction)
  ].filter(Boolean)

  const failed   = checks.filter(c => c.passed === false)   // null (SKIPPED) is not a failure
  const passed   = checks.filter(c => c.passed === true)
  const blocking = failed.filter(c => c.severity === 'error')

  // Group the recommended layers so the UI can say "one vision pass would
  // address three findings" rather than listing them separately.
  const byLayer = {}
  for (const c of failed) {
    if (!c.suggestedLayer || c.suggestedLayer === 'none') continue
    byLayer[c.suggestedLayer] = byLayer[c.suggestedLayer] || []
    byLayer[c.suggestedLayer].push(c.name)
  }

  return {
    checks,
    passedCount: passed.length,
    totalCount: checks.length,
    failedCount: failed.length,
    blockingCount: blocking.length,
    // No autonomous action. This is a recommendation for a reviewer.
    recommendation: blocking.length > 0 ? 'HUMAN_REVIEW' : 'PROCEED',
    suggestedLayers: byLayer
  }
}

module.exports = {
  reconcile,
  FAILURE,
  REMEDY,
  stateForZip,
  checkExtractionCompleteness,
  checkZeroValueRows,
  checkAddressProvenance,
  checkTaxCriticalPresence,
  checkEngineAvailability,
  checkAmountSourceConflict
}
