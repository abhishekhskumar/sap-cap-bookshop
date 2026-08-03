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

module.exports = { upsertResult, getAll, getByVendor, getByInvoice };
