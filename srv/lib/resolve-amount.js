'use strict'
/**
 * srv/lib/resolve-amount.js
 *
 * Shared helper for invoice amount fields that arrive from two independent
 * extraction sources — typically a line-item sum and a document-level header
 * field — that represent the same physical charge.
 *
 * The structural defect this generalises:
 *
 *   freightTotal = lineFreightTotal + headerFreightAmt   // ← double-counts
 *
 * has been found three times in three pipeline layers (DocAI freight,
 * Vision freight, Doc AI tax).  The ship-to address resolution already solved
 * the same problem for text fields by declaring a precedence order, logging
 * when multiple sources are present, and warning when they disagree.  This
 * module applies that strategy to numeric amounts.
 *
 * Usage
 * -----
 *   const { resolveAmount } = require('./lib/resolve-amount')
 *   const r = resolveAmount(lineFreightTotal, headerFreightAmt, {
 *     label: 'freight', precedence: 'line', documentId
 *   })
 *   const freightTotal = r.value   // replaces lineFreightTotal + headerFreightAmt
 *
 * The returned descriptor should be collected and passed to reconcile() and
 * _runConsistencyChecks() as `amountSources` so conflicts surface in the UI.
 */

/** Matches SELF_BALANCE_TOLERANCE used in the browser-side self-balance gate. */
const RESOLVE_AMOUNT_TOLERANCE = 1.00

/**
 * Resolve an invoice amount from two independent extraction sources.
 *
 * @param {number} lineTotal   Amount derived from summing extracted line rows
 *                             (e.g. Σ suppressed freight rows).  Pass 0 if absent.
 * @param {number} headerAmt   Amount from a document-level header field
 *                             (e.g. shippingCostHeader, taxAmount).  Pass 0 if absent.
 * @param {object} opts
 * @param {string}           opts.label
 *   Human-readable field name written to log messages (e.g. 'freight', 'tax').
 * @param {'line'|'header'} [opts.precedence='line']
 *   Which source wins when both are non-zero.
 *   'line'   → line-item sum is authoritative (preferred for freight:
 *              line items are atomic and more granular than a header total).
 *   'header' → header field is authoritative (preferred for tax:
 *              the header taxAmount is the document's stated total and is
 *              less likely to miss a component than summing individual lines).
 * @param {number}  [opts.tolerance=RESOLVE_AMOUNT_TOLERANCE]
 *   Maximum acceptable difference (absolute) before the two sources are
 *   considered to conflict.
 * @param {string}  [opts.documentId]
 *   Invoice ID injected into log/warn messages for traceability.
 *
 * @returns {{
 *   value:     number,               Use this instead of raw line/header.
 *   source:   'line'|'header'|'none',
 *   label:     string,
 *   conflict:  boolean,              true when both present and diff > tolerance.
 *   lineTotal: number,
 *   headerAmt: number,
 *   diff:      number|undefined      |lineTotal − headerAmt| when both present.
 * }}
 */
function resolveAmount(lineTotal, headerAmt, opts) {
  const label      = (opts && opts.label)                    || 'amount'
  const precedence = (opts && opts.precedence)               || 'line'
  const tolerance  = (opts && opts.tolerance != null)
                       ? opts.tolerance : RESOLVE_AMOUNT_TOLERANCE
  const tag        = (opts && opts.documentId)
                       ? ' [' + opts.documentId + ']' : ''

  const line = +(lineTotal || 0)
  const hdr  = +(headerAmt  || 0)

  // Neither source carries a value — nothing to resolve.
  if (line === 0 && hdr === 0) {
    return { value: 0, source: 'none', label, conflict: false, lineTotal: 0, headerAmt: 0 }
  }
  // Only one source populated — no ambiguity.
  if (line > 0 && hdr === 0) {
    return { value: line, source: 'line', label, conflict: false, lineTotal: line, headerAmt: 0 }
  }
  if (line === 0 && hdr > 0) {
    return { value: hdr, source: 'header', label, conflict: false, lineTotal: 0, headerAmt: hdr }
  }

  // Both sources populated — check agreement and apply precedence.
  const diff    = +Math.abs(line - hdr).toFixed(2)
  const conflict = diff > tolerance

  if (conflict) {
    console.warn(
      'RESOLVE_AMOUNT CONFLICT' + tag + ' ' + label +
      ': line=' + line + ' header=' + hdr +
      ' diff=' + diff + ' — using ' + precedence + ' (page-scope or multi-block duplication likely)'
    )
  } else {
    console.log(
      'RESOLVE_AMOUNT BOTH_PRESENT' + tag + ' ' + label +
      ': line=' + line + ' header=' + hdr +
      ' diff=' + diff + ' — sources agree; using ' + precedence
    )
  }

  const value = (precedence === 'header') ? hdr : line
  return { value, source: precedence, label, conflict, lineTotal: line, headerAmt: hdr, diff }
}

module.exports = { resolveAmount, RESOLVE_AMOUNT_TOLERANCE }
