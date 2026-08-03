'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Writes go to OS temp so cds watch never sees the file change and does not
// reload the browser.  On a fresh start the committed seed in srv/data/ is
// used as the initial dataset; subsequent writes accumulate in the temp file.
const SEED_PATH  = path.join(__dirname, '../data/invoice-results-store.json');
const STORE_PATH = path.join(os.tmpdir(), 'cds-invoice-store.json');

function _load() {
  // Prefer the runtime store (current session results); fall back to the
  // committed seed so pre-processed demo invoices are available on first boot.
  for (const p of [STORE_PATH, SEED_PATH]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  }
  return { byVendor: {}, byInvoice: {}, meta: { totalInvoices: 0, totalVendors: 0, lastUpdated: null } };
}

function _save(store) {
  store.meta.lastUpdated    = new Date().toISOString();
  store.meta.totalInvoices  = Object.keys(store.byInvoice).length;
  store.meta.totalVendors   = Object.keys(store.byVendor).length;
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// Upsert an invoice result record.
// record must have: documentId (string) and canonicalVendorKey (string).
// Same documentId on re-process → update in place; does NOT create a duplicate.
function upsertResult(record) {
  if (!record || !record.documentId || !record.canonicalVendorKey) {
    throw new Error('vendor-store.upsertResult: record requires documentId and canonicalVendorKey');
  }
  const store = _load();
  const { documentId, canonicalVendorKey } = record;

  // byInvoice: one entry per documentId (latest stage wins on re-process)
  store.byInvoice[documentId] = record;

  // byVendor: array of invoice records under the canonical key
  if (!store.byVendor[canonicalVendorKey]) store.byVendor[canonicalVendorKey] = [];
  const idx = store.byVendor[canonicalVendorKey].findIndex(r => r.documentId === documentId);
  if (idx >= 0) {
    store.byVendor[canonicalVendorKey][idx] = record; // update
  } else {
    store.byVendor[canonicalVendorKey].push(record);  // insert
  }

  _save(store);
  return record;
}

function getAll()                   { return _load(); }
function getByVendor(vendorKey)     { return _load().byVendor[vendorKey] || []; }
function getByInvoice(documentId)   { return _load().byInvoice[documentId] || null; }

// ── Read-side aggregation (Step 3 Vendor Intelligence) ────────────────────

function _topFrequency(arr) {
  if (!arr || !arr.length) return null;
  const c = {};
  for (const v of arr) if (v) c[v] = (c[v] || 0) + 1;
  const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function getSummary() {
  const store = _load();
  const vendors = [];

  for (const [vendorKey, records] of Object.entries(store.byVendor || {})) {
    if (!records || !records.length) continue;
    const sample = records[0];
    let undercharged = 0, overcharged = 0, accurate = 0, unavailable = 0, vendorTaxUnknown = 0;
    let totalAccrualExposure = 0, totalOverchargeAmount = 0, missingJurisdiction = 0;
    const allCorrectionActions = [], allCorrectedFields = [];
    const invoiceSummaries = [];

    for (const r of records) {
      const status = (r.taxOutcome && r.taxOutcome.chargeabilityStatus) || 'UNAVAILABLE';
      const fin    = r.financials  || {};
      const j      = r.jurisdiction || {};
      const corr   = r.corrections  || {};

      if      (status === 'UNDERCHARGED')       { undercharged++; if (fin.proposedAccrualAmount != null) totalAccrualExposure  += fin.proposedAccrualAmount; }
      else if (status === 'OVERCHARGED')        { overcharged++;  if (fin.taxAmountDifference    != null) totalOverchargeAmount += Math.abs(fin.taxAmountDifference); }
      else if (status === 'ACCURATELY_CHARGED') { accurate++; }
      else if (status === 'UNAVAILABLE')        { unavailable++; }
      else if (status === 'VENDOR_TAX_UNKNOWN') { vendorTaxUnknown++; }

      // Guard sentinel strings (e.g. "Manual Action Required — …") written into jurisdiction fields;
      // treat any state/ZIP string longer than a real abbreviation/ZIP as missing.
      const safeState = (typeof j.state      === 'string' && j.state.length      > 5)  ? null : j.state;
      const safeZip   = (typeof j.postalCode === 'string' && j.postalCode.length > 10) ? null : j.postalCode;
      if (!safeState && !safeZip) missingJurisdiction++;

      allCorrectionActions.push(...(corr.correctionActions  || []));
      allCorrectedFields.push( ...(corr.correctedFieldNames || []));

      invoiceSummaries.push({
        documentId:            r.documentId,
        invoiceNumber:         r.invoiceNumber,
        documentDate:          r.documentDate,
        stage:                 r.stage,
        chargeabilityStatus:   status,
        accrualStatus:         (r.taxOutcome && r.taxOutcome.accrualStatus) || null,
        proposedAccrualAmount: fin.proposedAccrualAmount != null ? fin.proposedAccrualAmount : null,
        taxAmountDifference:   fin.taxAmountDifference   != null ? fin.taxAmountDifference   : null,
        invoiceGrossTotal:     fin.invoiceGrossTotal      != null ? fin.invoiceGrossTotal      : null,
        jurisdiction: { state: safeState, postalCode: safeZip, city: j.city || null }
      });
    }

    const n = records.length;
    // Build a one-line pattern note for the risk table
    let patternNote;
    if      (undercharged === n) patternNote = 'consistently undercharged';
    else if (accurate     === n) patternNote = 'consistently accurate';
    else if (overcharged  === n) patternNote = 'overcharged on all invoices';
    else if (vendorTaxUnknown === n) patternNote = 'no tax stated on any invoice';
    else if (unavailable === n && missingJurisdiction === n)
      patternNote = `${unavailable} invoice${unavailable !== 1 ? 's' : ''} blocked — missing address`;
    else {
      const parts = [];
      if (undercharged)    parts.push(`${undercharged} undercharged`);
      if (overcharged)     parts.push(`${overcharged} overcharged`);
      if (accurate)        parts.push(`${accurate} accurate`);
      if (unavailable)     parts.push(`${unavailable} unavailable`);
      if (vendorTaxUnknown) parts.push(`${vendorTaxUnknown} tax-unknown`);
      patternNote = parts.join(', ');
    }
    if (missingJurisdiction > 0 && missingJurisdiction < n)
      patternNote += ` (${missingJurisdiction} missing address)`;
    const topCorrected = _topFrequency(allCorrectedFields);
    if (topCorrected) patternNote += ` · frequent correction: ${topCorrected}`;

    vendors.push({
      canonicalVendorKey: vendorKey,
      canonicalVendorName: sample.canonicalVendorName || vendorKey,
      invoiceCount: n,
      breakdown: { undercharged, overcharged, accurate, unavailable, vendorTaxUnknown },
      totalAccrualExposure:  +totalAccrualExposure.toFixed(2),
      totalOverchargeAmount: +totalOverchargeAmount.toFixed(2),
      missingJurisdictionCount: missingJurisdiction,
      patternNote,
      topCorrectionAction: _topFrequency(allCorrectionActions),
      invoices: invoiceSummaries
    });
  }

  // Default sort: total accrual exposure desc, then name asc
  vendors.sort((a, b) =>
    b.totalAccrualExposure - a.totalAccrualExposure ||
    a.canonicalVendorName.localeCompare(b.canonicalVendorName)
  );
  return { vendors, meta: store.meta };
}

module.exports = { upsertResult, getAll, getByVendor, getByInvoice, getSummary };
