'use strict'
/**
 * Unit tests for srv/lib/resolve-amount.js
 *
 * Run: node srv/lib/resolve-amount.test.js
 */

const assert = require('assert')
const { resolveAmount, RESOLVE_AMOUNT_TOLERANCE } = require('./resolve-amount')

let passed = 0, failed = 0

function test(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name) }
  catch(e) { failed++; console.error('  FAIL  ' + name + '\n        ' + e.message) }
}

// ── Neither source ────────────────────────────────────────────────────────────

test('both zero → value=0, source=none, no conflict', function () {
  const r = resolveAmount(0, 0, { label: 'freight' })
  assert.strictEqual(r.value, 0)
  assert.strictEqual(r.source, 'none')
  assert.strictEqual(r.conflict, false)
})

test('null inputs treated as 0', function () {
  const r = resolveAmount(null, null, { label: 'freight' })
  assert.strictEqual(r.value, 0)
  assert.strictEqual(r.source, 'none')
})

// ── Single source ─────────────────────────────────────────────────────────────

test('only line total → value=line, source=line', function () {
  const r = resolveAmount(1768.79, 0, { label: 'freight', precedence: 'line' })
  assert.strictEqual(r.value, 1768.79)
  assert.strictEqual(r.source, 'line')
  assert.strictEqual(r.conflict, false)
  assert.strictEqual(r.headerAmt, 0)
})

test('only header amt → value=header, source=header', function () {
  const r = resolveAmount(0, 1768.79, { label: 'freight', precedence: 'line' })
  assert.strictEqual(r.value, 1768.79)
  assert.strictEqual(r.source, 'header')
  assert.strictEqual(r.conflict, false)
})

// ── Both sources agree ────────────────────────────────────────────────────────

test('both agree (diff=0) with precedence=line → value=line, no conflict', function () {
  const r = resolveAmount(1768.79, 1768.79, { label: 'freight', precedence: 'line' })
  assert.strictEqual(r.value, 1768.79)
  assert.strictEqual(r.source, 'line')
  assert.strictEqual(r.conflict, false)
  assert.strictEqual(r.diff, 0)
})

test('both agree (diff=0) with precedence=header → value=header, no conflict', function () {
  const r = resolveAmount(10612.76, 10612.76, { label: 'tax', precedence: 'header' })
  assert.strictEqual(r.value, 10612.76)
  assert.strictEqual(r.source, 'header')
  assert.strictEqual(r.conflict, false)
})

test('both present, diff within tolerance (0.50) → no conflict', function () {
  const r = resolveAmount(1768.79, 1768.30, { label: 'freight', precedence: 'line' })
  assert.strictEqual(r.conflict, false)
  assert.strictEqual(r.diff, 0.49)
  assert.strictEqual(r.value, 1768.79)    // line wins
})

// ── Both sources conflict ─────────────────────────────────────────────────────

// 8505870001.pdf — DocAI freight: line items (2 subaccount pages) vs header field.
// lineTotal = 3,537.58 (2 × 1,768.79)  headerAmt = 1,768.79  diff = 1,768.79 > 1.00
// resolveAmount must: flag conflict=true, return the line-item total, NOT the sum.
test('freight conflict: line=3537.58 header=1768.79 → conflict=true, value=3537.58 (line wins)', function () {
  const r = resolveAmount(3537.58, 1768.79, { label: 'freight', precedence: 'line', documentId: '8505870001' })
  assert.strictEqual(r.conflict, true)
  assert.strictEqual(r.value, 3537.58)    // line wins (not the sum 5306.37!)
  assert.strictEqual(r.source, 'line')
  assert.strictEqual(r.diff, 1768.79)
  assert.strictEqual(r.lineTotal, 3537.58)
  assert.strictEqual(r.headerAmt, 1768.79)
})

// Additive bug: OLD code would return 5306.37 — confirm the helper never does that.
test('freight conflict: resolved value is NEVER the sum of both sources', function () {
  const r = resolveAmount(3537.58, 1768.79, { label: 'freight', precedence: 'line' })
  assert.notStrictEqual(r.value, 3537.58 + 1768.79,
    'value must not be the sum of line + header (that is the old double-count bug)')
})

// Tax conflict: header field is authoritative.
test('tax conflict: line=500 header=450 → conflict=true, value=450 (header wins)', function () {
  const r = resolveAmount(500, 450, { label: 'tax', precedence: 'header' })
  assert.strictEqual(r.conflict, true)
  assert.strictEqual(r.value, 450)        // header wins
  assert.strictEqual(r.source, 'header')
  assert.strictEqual(r.diff, 50)
})

// ── Precedence correctness ────────────────────────────────────────────────────

test('precedence=line: line wins even when header is larger', function () {
  const r = resolveAmount(100, 999, { label: 'freight', precedence: 'line' })
  assert.strictEqual(r.value, 100)
})

test('precedence=header: header wins even when line is larger', function () {
  const r = resolveAmount(999, 100, { label: 'tax', precedence: 'header' })
  assert.strictEqual(r.value, 100)
})

// ── label is preserved in result ──────────────────────────────────────────────

test('result carries label', function () {
  const r = resolveAmount(100, 200, { label: 'freight', precedence: 'line' })
  assert.strictEqual(r.label, 'freight')
})

// ── Custom tolerance ──────────────────────────────────────────────────────────

test('custom tolerance: diff=2.00 within tolerance=5.00 → no conflict', function () {
  const r = resolveAmount(100, 102, { label: 'freight', precedence: 'line', tolerance: 5 })
  assert.strictEqual(r.conflict, false)
})

test('custom tolerance: diff=2.00 outside tolerance=1.00 → conflict', function () {
  const r = resolveAmount(100, 102, { label: 'freight', precedence: 'line', tolerance: 1 })
  assert.strictEqual(r.conflict, true)
})

// ── Module constants ──────────────────────────────────────────────────────────

test('RESOLVE_AMOUNT_TOLERANCE exported and equals 1.00', function () {
  assert.strictEqual(RESOLVE_AMOUNT_TOLERANCE, 1.00)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed) process.exit(1)
