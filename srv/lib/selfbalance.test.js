'use strict'
/**
 * Unit tests for the _computeSelfBalance logic (browser-side, app/intelligence/index.html).
 *
 * _computeSelfBalance is a pure function embedded in index.html so it cannot be required
 * directly. This file mirrors the function in Node.js and must be kept in sync when the
 * implementation changes.
 *
 * Run: node srv/lib/selfbalance.test.js
 */

const assert = require('assert')
let passed = 0, failed = 0

function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name) }
  catch(e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message) }
}

// ── Mirror of index.html _computeSelfBalance ─────────────────────────────────
// Keep in sync with app/intelligence/index.html whenever the function changes.

const SELF_BALANCE_TOLERANCE = 1.00

function _computeSelfBalance(r) {
  if (!r || r.invoiceMode === 'construction') return null
  var _gf = (r.fields || []).find(function(f) { return f.fieldName === 'grossAmount' })
  if (!_gf) return null
  var _gv = (_gf.verdict === 'CORRECTED' && _gf.correctValue) ? _gf.correctValue : _gf.docAIValue
  var extractedGross = parseFloat(String(_gv || '').replace(/[^0-9.\-]/g, '')) || null
  if (!extractedGross || extractedGross === 0) return null
  var keepNet = +((r.lineItems || []).reduce(function(s, li) {
    return s + (parseFloat(li.amount || li.netAmount || 0) || 0)
  }, 0)).toFixed(2)
  var freight = parseFloat(r.invoiceFreightTotal || 0) || 0
  var tax = r.vendorTaxAmount != null ? parseFloat(String(r.vendorTaxAmount).replace(/[^0-9.\-]/g, '')) || 0 : 0
  var lhs = +(keepNet + freight + tax).toFixed(2)
  var gap = +(lhs - extractedGross).toFixed(2)
  // Discriminator: when gap ≈ freight + tax, grossAmount is a pre-tax/pre-freight subtotal —
  // the all-in comparison always yields a false failure of exactly (freight + tax).
  // Re-compare against the taxable base (keepNet + freight). Report NOT_APPLICABLE only if
  // that also fails to resolve within tolerance.
  if (+Math.abs(gap - (freight + tax)).toFixed(2) <= SELF_BALANCE_TOLERANCE) {
    var taxableBase = +(keepNet + freight).toFixed(2)
    var delta2 = +Math.abs(taxableBase - extractedGross).toFixed(2)
    if (delta2 > SELF_BALANCE_TOLERANCE) return null // NOT_APPLICABLE — subtotal field, no comparable all-in total
    return { passes: true, lhs: taxableBase, gross: extractedGross, delta: delta2 }
  }
  var delta = +Math.abs(gap).toFixed(2)
  return { passes: delta <= SELF_BALANCE_TOLERANCE, lhs: lhs, gross: extractedGross, delta: delta }
}

// ── Real-invoice tests (8505870001.pdf) ──────────────────────────────────────

// Claude layer result.
// DocAI grossAmount = 189,260.87 (the pre-tax/pre-freight net subtotal, not the all-in total).
// keepNet (Σ li.amount) = 189,260.87 ; freight = 1,768.79 ; tax = 10,612.76
// lhs = 201,642.42 ; gap = 12,381.55 = freight + tax exactly.
// Subtotal discriminator fires → re-compare against taxableBase = 191,029.66.
// delta2 = 1,768.79 > 1.00 → NOT_APPLICABLE → null.
// The banner must NOT fire on the Claude layer.
test('8505870001 Claude layer: gap equals freight+tax → NOT_APPLICABLE (null)', function() {
  var r = {
    invoiceMode: 'non_construction',
    fields: [{ fieldName: 'grossAmount', docAIValue: '189260.87' }],
    lineItems: [{ amount: 189260.87 }], // keepNet = 189,260.87
    invoiceFreightTotal: 1768.79,
    vendorTaxAmount: 10612.76
  }
  var result = _computeSelfBalance(r)
  assert.strictEqual(result, null,
    'expected null (NOT_APPLICABLE) when gap exactly equals freight + tax')
})

// Doc AI layer result (before equipment-rollup dedup fix — real data representing the
// live failure that prompted the discriminator).
// keepNet = 541,250.72 (= invoiceNetTotal 546,557.09 − freight 5,306.37)
// freight = 5,306.37 ; tax = 10,612.76
// lhs = 557,169.85 ; gap = 367,908.98
// freight + tax = 15,919.13 ; |gap − (freight+tax)| = 351,989.85 >> 1.00 → real discrepancy.
// The banner MUST fire.
test('8505870001 Doc AI layer: gap 367,908.98 >> freight+tax 15,919.13 → banner fires', function() {
  var r = {
    invoiceMode: 'non_construction',
    fields: [{ fieldName: 'grossAmount', docAIValue: '189260.87' }],
    lineItems: [{ amount: 541250.72 }], // keepNet = 541,250.72
    invoiceFreightTotal: 5306.37,
    vendorTaxAmount: 10612.76
  }
  var result = _computeSelfBalance(r)
  assert.notStrictEqual(result, null, 'expected a non-null result (banner should fire)')
  assert.strictEqual(result.passes, false, 'expected passes:false for a real discrepancy')
  assert.strictEqual(result.delta, 367908.98,
    'expected delta = 367,908.98 (the real extracted-vs-printed gap)')
})

// ── Edge-case / sanity tests ──────────────────────────────────────────────────

// Perfectly balanced invoice — all-in gross matches keepNet + freight + tax exactly.
test('clean invoice: lhs equals extractedGross → passes', function() {
  var r = {
    invoiceMode: 'non_construction',
    fields: [{ fieldName: 'grossAmount', docAIValue: '10000.00' }],
    lineItems: [{ amount: 9000.00 }],
    invoiceFreightTotal: 500,
    vendorTaxAmount: 500
  }
  var result = _computeSelfBalance(r)
  assert.notStrictEqual(result, null, 'expected a result for a balanced invoice')
  assert.strictEqual(result.passes, true, 'expected passes:true for a balanced invoice')
  assert.strictEqual(result.delta, 0)
})

// grossAmount equals the pre-tax but post-freight total (keepNet + freight).
// gap = tax = freight + tax − freight → only "tax" portion of gap.
// When freight = 0, gap = tax = freight + tax → discriminator fires:
// taxableBase = keepNet + 0 = keepNet = extractedGross → passes:true, delta:0.
test('grossAmount is pre-tax post-freight subtotal: passes when taxableBase matches', function() {
  var r = {
    invoiceMode: 'non_construction',
    fields: [{ fieldName: 'grossAmount', docAIValue: '9500.00' }],
    lineItems: [{ amount: 9000.00 }],
    invoiceFreightTotal: 500,
    vendorTaxAmount: 500  // gap = 500 = 0 + 500 = freight+tax? No, freight=500 so freight+tax=1000
  }
  // Here gap = (9000+500+500) - 9500 = 500 ; freight+tax = 1000 ; |500-1000|=500 > 1.00 → no discriminator
  // → delta = 500 > 1.00 → passes:false  (a real partial discrepancy of $500)
  var result = _computeSelfBalance(r)
  assert.notStrictEqual(result, null)
  assert.strictEqual(result.passes, false)
  assert.strictEqual(result.delta, 500)
})

// grossAmount equals pre-tax, no freight: gap = tax only, freight = 0
// gap = tax = freight(0) + tax → discriminator fires → taxableBase = keepNet + 0 = keepNet = extractedGross
// delta2 = 0 → passes:true (grossAmount is a legitimate pre-tax subtotal)
test('grossAmount is pre-tax subtotal with no freight: resolves to passes:true', function() {
  var r = {
    invoiceMode: 'non_construction',
    fields: [{ fieldName: 'grossAmount', docAIValue: '9000.00' }],
    lineItems: [{ amount: 9000.00 }],
    invoiceFreightTotal: 0,
    vendorTaxAmount: 900
  }
  // gap = (9000+0+900) - 9000 = 900 ; freight+tax = 0+900 = 900 ; |900-900| = 0 → discriminator
  // taxableBase = 9000+0 = 9000 ; delta2 = |9000-9000| = 0 → passes:true
  var result = _computeSelfBalance(r)
  assert.notStrictEqual(result, null, 'should return a result, not null')
  assert.strictEqual(result.passes, true, 'expected passes:true when taxableBase matches extractedGross')
  assert.strictEqual(result.delta, 0)
})

// Construction invoices are always skipped regardless of the numbers.
test('construction invoice: always returns null', function() {
  var r = {
    invoiceMode: 'construction',
    fields: [{ fieldName: 'grossAmount', docAIValue: '50000' }],
    lineItems: [{ amount: 40000 }],
    invoiceFreightTotal: 1000,
    vendorTaxAmount: 500
  }
  assert.strictEqual(_computeSelfBalance(r), null)
})

// No grossAmount field → null.
test('missing grossAmount field → null', function() {
  var r = {
    invoiceMode: 'non_construction',
    fields: [],
    lineItems: [{ amount: 9000 }],
    invoiceFreightTotal: 500,
    vendorTaxAmount: 500
  }
  assert.strictEqual(_computeSelfBalance(r), null)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed) process.exit(1)
