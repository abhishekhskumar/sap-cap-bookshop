'use strict';

/**
 * Golden-baseline verifier.
 *
 * Reads each file in test/golden-baseline/*.json, looks up the same documentId
 * in the live vendor-store, and does a field-by-field comparison of every key
 * that affects correctness (chargeability, financials, jurisdiction, taxability,
 * corrections, freight).  Timestamp / meta fields are intentionally excluded.
 *
 * Usage:  node test/verify-golden.js
 * Exit 0 = all pass.  Exit 1 = one or more mismatches.
 */

const fs   = require('fs');
const path = require('path');

const GOLDEN_DIR = path.join(__dirname, 'golden-baseline');
const vendorStore = require('../srv/adapters/vendor-store');

// Fields that must match exactly between golden and live record.
// Nested paths use dot notation; arrays are JSON-serialised for comparison.
const CHECKED_PATHS = [
  'canonicalVendorKey',
  'canonicalVendorName',
  'stage',
  'invoiceNumber',
  'invoiceMode',
  'jurisdiction.state',
  'jurisdiction.postalCode',
  'jurisdiction.city',
  'financials.invoiceNetTotal',
  'financials.invoiceGrossTotal',
  'financials.vendorTaxAmount',
  'financials.proposedAccrualAmount',
  'financials.taxAmountDifference',
  'taxOutcome.chargeabilityStatus',
  'taxOutcome.accrualStatus',
  'taxOutcome.systemRate',
  'taxOutcome.invoiceEffectiveRate',
  'taxOutcome.taxRateDifference',
  'taxOutcome.exemptLinesPresent',
  'taxabilityFlags.totalLines',
  'taxabilityFlags.taxableLines',
  'taxabilityFlags.exemptLines',
  'taxabilityFlags.uncertainLines',
  'corrections.headerFieldsCorrected',
  'corrections.headerFieldsFlagged',
  'corrections.correctedFieldNames',   // array → JSON
  'corrections.flaggedFieldNames',      // array → JSON
  'corrections.lineItemCorrectionCount',
  'corrections.correctionActions',      // array → JSON
  'freightVerdict',
  'freightTaxedByVendor',
];

function getAt(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

function serialize(v) {
  if (v === undefined) return '__undefined__';
  if (Array.isArray(v)) return JSON.stringify(v);
  return String(v);
}

function verify(goldenPath, liveAll) {
  const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
  const { documentId } = golden;
  const live = liveAll.byInvoice[documentId];
  const label = path.basename(goldenPath);

  if (!live) {
    console.error(`FAIL  ${label}  →  documentId ${documentId} not found in live store`);
    return false;
  }

  let allPass = true;
  const failures = [];
  for (const p of CHECKED_PATHS) {
    const gVal = serialize(getAt(golden, p));
    const lVal = serialize(getAt(live,   p));
    if (gVal !== lVal) {
      failures.push(`  MISMATCH  ${p}\n    golden: ${gVal}\n    live:   ${lVal}`);
      allPass = false;
    }
  }

  if (allPass) {
    console.log(`PASS  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failures.forEach(f => console.error(f));
  }
  return allPass;
}

const files = fs.readdirSync(GOLDEN_DIR).filter(f => f.endsWith('.json'));
if (!files.length) {
  console.error('No golden baseline files found in', GOLDEN_DIR);
  process.exit(1);
}

const liveAll = vendorStore.getAll();
let allGood = true;
for (const f of files) {
  const ok = verify(path.join(GOLDEN_DIR, f), liveAll);
  if (!ok) allGood = false;
}

console.log('\n' + (allGood ? 'ALL PASS — store matches golden baseline.' : 'FAILURES — store diverges from golden baseline.'));
process.exit(allGood ? 0 : 1);
