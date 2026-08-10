/**
 * srv/lib/reconcile.test.js
 *
 *   node reconcile.test.js
 *
 * No pytest equivalent needed -- plain assertions, no dependencies.
 * The first fixture uses the real numbers from 8500016523.pdf.
 */

'use strict'

const assert = require('assert')
const { reconcile, stateForZip, FAILURE, checkExtractionCompleteness, checkAmountSourceConflict } = require('./reconcile.js')

let passed = 0, failed = 0

function test (name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); passed++ }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++ }
}

// ---------------------------------------------------------------------------
// The real document
// ---------------------------------------------------------------------------

const REAL = {
  grossAmount: 439950.56,
  invoiceNetTotal: 413937.03,
  shipToCity: 'Katy',
  shipToPostalCode: '77002',
  shipToState: 'TX',
  _provenance: { shipTo: { city: 'project', postalCode: 'shipto', state: 'project' } },
  taxEngineResults: { vertex: { available: false }, avalara: { available: false } },
  fields: [
    { fieldName: 'taxAmount', docAIValue: '', confidence: 0, taxCritical: true },
    { fieldName: 'grossAmount', docAIValue: '', confidence: 0, taxCritical: true },
    { fieldName: 'shipToState', docAIValue: 'TX', confidence: 78, taxCritical: true }
  ],
  keepLines: [
    ...Array.from({ length: 97 }, (_, i) => ({ description: `Trade ${i}`, amount: 4000 })),
    { description: "Builder's Risk Insurance", amount: 0 },
    { description: 'Final Clean/Weekly Clean', amount: 0 },
    { description: 'RECEPTION/ELEVATOR LOBBY', amount: 0 },
    { description: 'Rubber Base', amount: 0 },
    { description: 'Floor Float/Prep', amount: 0 },
    { description: 'Paint', amount: 0 },
    { description: 'RESTROOMS', amount: 0 },
    { description: 'Carpet', amount: 0 },
    { description: 'Electrical', amount: 0 }
  ]
}

test('real document: extraction shortfall is caught', () => {
  const r = reconcile(REAL)
  const c = r.checks.find(x => x.name === 'extractedLinesReconcileToPrintedTotal')
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.failureMode, FAILURE.EXTRACTION_SHORTFALL)
  assert.strictEqual(c.values.gap, 26013.53)
  assert.ok(c.values.ratio > 0.05 && c.values.ratio < 0.07)
})

test('real document: zero-value rows flagged', () => {
  const r = reconcile(REAL)
  const c = r.checks.find(x => x.name === 'zeroValueRowRatio')
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.values.zeroCount, 9)
})

test('real document: mixed address provenance caught', () => {
  const r = reconcile(REAL)
  const c = r.checks.find(x => x.name === 'shipToComponentsCoherent')
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.failureMode, FAILURE.MIXED_PROVENANCE)
})

test('real document: taxAmount missing; grossAmount resolved via invoiceNetTotal', () => {
  // REAL has invoiceNetTotal: 413937.03 at the top level, so the empty grossAmount
  // header field is resolved — not reported as missing. taxAmount has no vendorTaxAmount
  // on this fixture, so it remains in the missing list and the check still FAILs.
  const r = reconcile(REAL)
  const c = r.checks.find(x => x.name === 'taxCriticalFieldsPresent')
  assert.strictEqual(c.passed, false)
  assert.deepStrictEqual(c.values.missing, ['taxAmount'])
  assert.deepStrictEqual(c.values.resolvedFromTopLevel, ['grossAmount'])
  assert.ok(c.message.includes('invoiceNetTotal'), 'message should cite the resolved source')
})

test('real document: no engine connected is flagged', () => {
  const r = reconcile(REAL)
  const c = r.checks.find(x => x.name === 'taxEngineAvailable')
  assert.strictEqual(c.passed, false)
})

test('real document: recommends human review', () => {
  const r = reconcile(REAL)
  assert.strictEqual(r.recommendation, 'HUMAN_REVIEW')
  assert.ok(r.blockingCount >= 3)
})

test('real document: groups findings by remediation layer', () => {
  const r = reconcile(REAL)
  assert.ok(r.suggestedLayers.vision.length >= 3,
    'one vision pass should address several findings')
})

// ---------------------------------------------------------------------------
// Line-item tax resolution — the invoice that triggered this fix
// ---------------------------------------------------------------------------

// Header taxAmount is empty (Doc AI found nothing in the header tax block).
// The normalisation pipeline read tax from line items and stored the resolved
// value in vendorTaxAmount. The check must treat the field as present and PASS.
const LINE_ITEM_TAX = {
  grossAmount: 42698.50,
  invoiceNetTotal: 42698.50,
  vendorTaxAmount: 4269.85,        // resolved from line items, not the header field
  shipToCity: 'Houston',
  shipToPostalCode: '77002',
  shipToState: 'TX',
  _provenance: { shipTo: { city: 'shipto', postalCode: 'shipto', state: 'shipto' } },
  taxEngineResults: { vertex: { available: true } },
  fields: [
    { fieldName: 'taxAmount',   docAIValue: '',     confidence: 0,  taxCritical: true },
    { fieldName: 'grossAmount', docAIValue: '',     confidence: 0,  taxCritical: true },
    { fieldName: 'shipToState', docAIValue: 'TX',   confidence: 96, taxCritical: true }
  ],
  keepLines: [{ description: 'Services', amount: 42698.50 }]
}

test('line-item tax: vendorTaxAmount present → taxAmount header empty is not missing', () => {
  const r = reconcile(LINE_ITEM_TAX)
  const c = r.checks.find(x => x.name === 'taxCriticalFieldsPresent')
  assert.strictEqual(c.passed, true,
    `expected PASS but got FAIL — missing: ${JSON.stringify(c.values.missing)}`)
  assert.deepStrictEqual(c.values.missing, [],
    'no fields should remain in the missing list')
  assert.ok(c.values.resolvedFromTopLevel.includes('taxAmount'),
    'taxAmount should appear in resolvedFromTopLevel')
  assert.ok(c.values.resolvedFromTopLevel.includes('grossAmount'),
    'grossAmount should appear in resolvedFromTopLevel (invoiceNetTotal)')
  assert.ok(c.message.includes('line-item tax resolution'),
    'message should explain that taxAmount was resolved from line items')
  assert.ok(c.message.includes('4269.85'),
    'message should include the resolved value')
})

test('line-item tax: vendorTaxAmount null → taxAmount header empty IS missing', () => {
  // Confirm the fallback: if the pipeline did NOT resolve a top-level value
  // (e.g. null), the header emptiness should still be flagged.
  const noTax = { ...LINE_ITEM_TAX, vendorTaxAmount: null }
  const r = reconcile(noTax)
  const c = r.checks.find(x => x.name === 'taxCriticalFieldsPresent')
  assert.strictEqual(c.passed, false)
  assert.ok(c.values.missing.includes('taxAmount'),
    'taxAmount must be in missing when vendorTaxAmount is null')
})

// ---------------------------------------------------------------------------
// checkExtractionCompleteness: two-pass sourcing and bidirectional gap
// ---------------------------------------------------------------------------

// The four non-construction invoices that triggered this fix used
// fields[grossAmount].docAIValue as the printed total — the same source
// that _computeSelfBalance / the UI "discrepancy" banner reads from.
// The extracted total is now net + freight + tax, mirroring the banner's LHS.

test('non-construction: fields.grossAmount sourced when top-level is absent', () => {
  // Matches the previously-skipped pattern: grossAmount at top level is null
  // (non-construction, no workCompletedThisPeriodTotal), but the raw DocAI
  // field value is present — same source as the UI discrepancy banner.
  const c = checkExtractionCompleteness({
    fields: [{ fieldName: 'grossAmount', docAIValue: '50000.00' }],
    invoiceNetTotal: 31702.06
    // no freight, no tax → extracted = 31702.06
  })
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.failureMode, FAILURE.EXTRACTION_SHORTFALL)
  assert.strictEqual(c.values.printedFrom, 'fields.grossAmount')
  assert.ok(c.provenance.includes('fields.grossAmount'),
    `provenance should cite source, got: ${c.provenance}`)
  assert.ok(c.message.includes('fields.grossAmount'),
    'message should name the source field')
  const expectedGap = +(50000.00 - 31702.06).toFixed(2)   // 18297.94
  assert.strictEqual(c.values.gap, expectedGap)
})

test('fields.totalAmountDue used when grossAmount field also absent', () => {
  // Covers vendors that name the total field differently.
  const c = checkExtractionCompleteness({
    fields: [{ fieldName: 'totalAmountDue', docAIValue: '8000.00' }],
    invoiceNetTotal: 8000.00
  })
  assert.strictEqual(c.values.printedFrom, 'fields.totalAmountDue')
  assert.strictEqual(c.passed, true)
})

test('printed total priority: top-level grossAmount beats fields.grossAmount', () => {
  // Top-level pass wins over fields[] pass even when both are present.
  const c = checkExtractionCompleteness({
    grossAmount: 100000.00,
    fields: [{ fieldName: 'grossAmount', docAIValue: '99000.00' }],
    invoiceNetTotal: 100000.00
  })
  assert.strictEqual(c.values.printedFrom, 'grossAmount',
    'top-level key should win over fields[] lookup')
  assert.strictEqual(c.passed, true)
})

test('printed total priority: workCompletedThisPeriodTotal beats top-level grossAmount', () => {
  const c = checkExtractionCompleteness({
    workCompletedThisPeriodTotal: 100000.00,
    grossAmount:                   99000.00,
    invoiceNetTotal:              100000.00
  })
  assert.strictEqual(c.values.printedFrom, 'workCompletedThisPeriodTotal')
  assert.strictEqual(c.passed, true)
})

test('check skipped when no printed total found in either pass', () => {
  // Guard: nothing in top-level keys or fields[] → SKIPPED, not a false pass.
  const c = checkExtractionCompleteness({ invoiceNetTotal: 5000.00 })
  assert.strictEqual(c.passed, null, 'should be SKIPPED, not PASS or FAIL')
  assert.ok(c.message.includes('skipped'))
  assert.ok(c.message.toLowerCase().includes('tried:'),
    'message should list what was attempted in both passes')
})

test('over-extraction: extracted > printed → EXTRACTION_OVERCOUNT (synthetic)', () => {
  // Rollup or subtotal rows counted alongside their components inflate the
  // extracted total above the document printed total.
  const c = checkExtractionCompleteness({
    grossAmount:     12480.00,
    invoiceNetTotal: 14523.47   // net alone already exceeds printed; no freight/tax
  })
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.failureMode, FAILURE.EXTRACTION_OVERCOUNT)
  assert.ok(c.values.gap < 0, `gap should be negative for over-extraction, got ${c.values.gap}`)
  assert.ok(c.message.toLowerCase().includes('over-extraction'),
    'message should state direction')
  assert.ok(
    c.message.toLowerCase().includes('rollup') || c.message.toLowerCase().includes('subtotal'),
    'message should explain likely cause')
})

test('over-extraction: suggestedLayer is vision (layout question)', () => {
  const c = checkExtractionCompleteness({
    grossAmount:     10000.00,
    invoiceNetTotal: 12000.00
  })
  assert.strictEqual(c.suggestedLayer, 'vision',
    'distinguishing subtotal from line item requires spatial context — only vision can resolve it')
})

// Real numbers from the four failing non-construction invoices.
// Both are over-extraction: line rows summed higher than the printed total,
// indicating rollup or subtotal rows were counted alongside their components.

test('over-extraction: 213,475.20 extracted vs 195,177.26 printed — real invoice', () => {
  const c = checkExtractionCompleteness({
    fields: [{ fieldName: 'grossAmount', docAIValue: '195177.26' }],
    invoiceNetTotal: 213475.20   // no freight/tax on this invoice
  })
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.failureMode, FAILURE.EXTRACTION_OVERCOUNT)
  assert.strictEqual(c.values.printedFrom, 'fields.grossAmount')
  const expectedGap = +(195177.26 - 213475.20).toFixed(2)   // -18297.94
  assert.strictEqual(c.values.gap, expectedGap,
    `expected gap ${expectedGap}, got ${c.values.gap}`)
  assert.ok(c.values.gap < 0, 'gap must be negative (over-extraction)')
})

test('over-extraction: 557,169.85 extracted vs 189,260.87 printed — $367k gap (8505870001.pdf)', () => {
  // The largest discrepancy that previously skipped: 367,908.98 gap.
  const c = checkExtractionCompleteness({
    fields: [{ fieldName: 'grossAmount', docAIValue: '189260.87' }],
    invoiceNetTotal: 557169.85
  })
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.failureMode, FAILURE.EXTRACTION_OVERCOUNT)
  assert.strictEqual(c.values.printedFrom, 'fields.grossAmount')
  const expectedGap = +(189260.87 - 557169.85).toFixed(2)   // -367908.98
  assert.strictEqual(c.values.gap, expectedGap,
    `expected gap ${expectedGap}, got ${c.values.gap}`)
  assert.ok(Math.abs(c.values.gap) > 300000,
    'gap magnitude must reflect the $367k discrepancy')
})

test('real document: printedFrom is grossAmount (pass-1 top-level)', () => {
  // REAL has grossAmount: 439950.56 at top level. workCompletedThisPeriodTotal
  // is absent from the fixture (not a top-level key in the result object),
  // so the check uses grossAmount as the second key in PRINTED_TOTAL_TOP_KEYS.
  // Existing gap and failure mode must be unchanged.
  const r = reconcile(REAL)
  const c = r.checks.find(x => x.name === 'extractedLinesReconcileToPrintedTotal')
  assert.strictEqual(c.values.printedFrom, 'grossAmount')
  assert.strictEqual(c.values.gap, 26013.53,
    'gap must match the real invoice discrepancy (26,013.53)')
  assert.strictEqual(c.failureMode, FAILURE.EXTRACTION_SHORTFALL)
})

// ---------------------------------------------------------------------------
// Clean document
// ---------------------------------------------------------------------------

const CLEAN = {
  grossAmount: 12480.00,
  invoiceNetTotal: 12480.00,
  shipToCity: 'Houston',
  shipToPostalCode: '77002',
  shipToState: 'TX',
  _provenance: { shipTo: { city: 'shipto', postalCode: 'shipto', state: 'shipto' } },
  taxEngineResults: { vertex: { available: true } },
  fields: [{ fieldName: 'shipToState', docAIValue: 'TX', confidence: 96, taxCritical: true }],
  keepLines: [{ description: 'Pump', amount: 12480 }]
}

test('clean document: everything passes', () => {
  const r = reconcile(CLEAN)
  assert.strictEqual(r.failedCount, 0, JSON.stringify(r.checks.filter(c => !c.passed)))
  assert.strictEqual(r.recommendation, 'PROCEED')
})

// ---------------------------------------------------------------------------
// The point of the exercise
// ---------------------------------------------------------------------------

test('a tautological check would have passed -- ours does not', () => {
  // The old check compared sum(lines) against invoiceNetTotal, which is
  // COMPUTED from sum(lines). It can never fail.
  const lineSum = REAL.keepLines.reduce((s, l) => s + l.amount, 0)
  const tautology = Math.abs(lineSum - lineSum) < 0.01
  assert.strictEqual(tautology, true, 'old check always passes')

  // Ours compares against the total printed on the document.
  const r = reconcile(REAL)
  const real = r.checks.find(x => x.name === 'extractedLinesReconcileToPrintedTotal')
  assert.strictEqual(real.passed, false, 'new check catches the shortfall')
})

test('zip to state lookup', () => {
  assert.strictEqual(stateForZip('77002'), 'TX')
  assert.strictEqual(stateForZip('77449'), 'TX')
  assert.strictEqual(stateForZip('90210'), 'CA')
  assert.strictEqual(stateForZip('10001'), 'NY')
  assert.strictEqual(stateForZip('abc'), null)
})

test('zip belonging to a different state is caught', () => {
  const r = reconcile({ ...CLEAN, shipToPostalCode: '90210', shipToState: 'TX',
    _provenance: { shipTo: { city: 'shipto', postalCode: 'shipto', state: 'shipto' } } })
  const c = r.checks.find(x => x.name === 'shipToComponentsCoherent')
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.failureMode, FAILURE.FIELD_CONFUSION)
})

// ---------------------------------------------------------------------------
// checkAmountSourceConflict
// ---------------------------------------------------------------------------

// 8505870001.pdf — DocAI freight: after the Vision-style fix (prefer line items over
// header field), DocAI lineFreightTotal = 3,537.58 (2 subaccount pages × 1,768.79)
// and headerFreightAmt = 1,768.79.  diff = 1,768.79 > 1.00 → conflict.
test('amountSourceConflict: freight line vs header disagree → check fires', () => {
  const extraction = {
    ...CLEAN,
    amountSources: [
      { label: 'freight', lineTotal: 3537.58, headerAmt: 1768.79, diff: 1768.79,
        value: 3537.58, source: 'line', conflict: true }
    ]
  }
  const c = checkAmountSourceConflict(extraction)
  assert.ok(c !== null, 'check should not be null (skipped) when conflict exists')
  assert.strictEqual(c.passed, false)
  assert.strictEqual(c.name, 'amountSourceConflict')
  assert.ok(c.message.includes('freight'), 'message should name the conflicting field')
  assert.ok(c.message.includes('3537.58'), 'message should include line total')
  assert.ok(c.message.includes('1768.79'), 'message should include header amount')
})

// Both sources agree on tax → no conflict, check SKIPPED
test('amountSourceConflict: freight both-present but agree → SKIPPED (null)', () => {
  const extraction = {
    ...CLEAN,
    amountSources: [
      { label: 'freight', lineTotal: 1768.79, headerAmt: 1768.79, diff: 0,
        value: 1768.79, source: 'line', conflict: false }
    ]
  }
  const c = checkAmountSourceConflict(extraction)
  assert.strictEqual(c, null, 'check must be null (SKIPPED) when both sources agree')
})

// No amountSources in extraction (pre-migration cached result) → SKIPPED
test('amountSourceConflict: no amountSources field → SKIPPED (null)', () => {
  const c = checkAmountSourceConflict(CLEAN)
  assert.strictEqual(c, null, 'check must be null (SKIPPED) when amountSources absent')
})

// reconcile() wires the check in — verify it appears in the result
test('reconcile() includes amountSourceConflict when conflict present', () => {
  const extraction = {
    ...CLEAN,
    amountSources: [
      { label: 'tax', lineTotal: 500, headerAmt: 450, diff: 50,
        value: 450, source: 'header', conflict: true }
    ]
  }
  const r = reconcile(extraction)
  const c = r.checks.find(x => x.name === 'amountSourceConflict')
  assert.ok(c, 'amountSourceConflict check must appear in reconcile() output')
  assert.strictEqual(c.passed, false)
  assert.ok(c.message.includes('tax'))
})

// reconcile() must NOT add amountSourceConflict when no conflicts
test('reconcile() omits amountSourceConflict when sources are absent', () => {
  const r = reconcile(CLEAN)
  const c = r.checks.find(x => x.name === 'amountSourceConflict')
  assert.strictEqual(c, undefined, 'check must not appear when no amountSources data')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
