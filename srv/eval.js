'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Field weights ─────────────────────────────────────────────────────────────
const FIELD_WEIGHTS = {
  shipToAddress:        3,
  shipToCity:           3,
  shipToState:          3,
  shipToPostalCode:     3,
  shipToCounty:         3,
  projectAddress:       3,
  contractDetails:      3,
  grossAmount:          3,
  taxAmount:            3,
  netAmount:            3,
  invoiceMode:          3,
  vendorName:           2,
  purchaseOrderNumber:  2,
  freight:              2,
  documentDate:         1,
  invoiceNumber:        1
};

// ─── Field-type classifiers ────────────────────────────────────────────────────
const DATE_FIELDS = new Set(['documentDate']);

const AMOUNT_FIELDS = new Set([
  'grossAmount', 'taxAmount', 'netAmount', 'taxAmountHeader',
  'totalTaxableAmount', 'nonTaxableAmount', 'subTotal',
  'shippingCostHeader', 'workCompletedThisPeriodTotal',
  'freight', 'invoiceNetTotal', 'freightAmount', 'itemAmount'
]);

const ADDRESS_FIELDS = new Set([
  'shipToAddress', 'projectAddress', 'contractDetails', 'accentureAddress'
]);

// Full US state name → 2-letter abbreviation
const STATE_MAP = {
  'alabama': 'al',         'alaska': 'ak',          'arizona': 'az',
  'arkansas': 'ar',        'california': 'ca',       'colorado': 'co',
  'connecticut': 'ct',     'delaware': 'de',          'florida': 'fl',
  'georgia': 'ga',         'hawaii': 'hi',            'idaho': 'id',
  'illinois': 'il',        'indiana': 'in',            'iowa': 'ia',
  'kansas': 'ks',          'kentucky': 'ky',           'louisiana': 'la',
  'maine': 'me',           'maryland': 'md',           'massachusetts': 'ma',
  'michigan': 'mi',        'minnesota': 'mn',          'mississippi': 'ms',
  'missouri': 'mo',        'montana': 'mt',            'nebraska': 'ne',
  'nevada': 'nv',          'new hampshire': 'nh',      'new jersey': 'nj',
  'new mexico': 'nm',      'new york': 'ny',           'north carolina': 'nc',
  'north dakota': 'nd',    'ohio': 'oh',               'oklahoma': 'ok',
  'oregon': 'or',          'pennsylvania': 'pa',       'rhode island': 'ri',
  'south carolina': 'sc',  'south dakota': 'sd',       'tennessee': 'tn',
  'texas': 'tx',           'utah': 'ut',               'vermont': 'vt',
  'virginia': 'va',        'washington': 'wa',         'west virginia': 'wv',
  'wisconsin': 'wi',       'wyoming': 'wy',            'district of columbia': 'dc'
};

// ─── Golden label loader ───────────────────────────────────────────────────────
/**
 * Reads srv/data/golden-labels.csv.
 * CSV must have a "scnid" column plus one column per labeled field.
 * Returns { scnid: { fieldName: correctValue, ... } }.
 * Only populated cells are included (empty string = unlabeled = omitted).
 */
function loadGoldenLabels() {
  const csvPath = path.join(__dirname, 'data', 'golden-labels.csv');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return {};

  const headers = parseCSVRow(lines[0]);
  const scnidIdx = headers.findIndex(h => h.toLowerCase() === 'scnid');
  if (scnidIdx === -1) throw new Error('golden-labels.csv must have a "scnid" column');

  const result = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    const scnid = (cols[scnidIdx] || '').trim();
    if (!scnid) continue;
    result[scnid] = {};
    for (let j = 0; j < headers.length; j++) {
      if (j === scnidIdx) continue;
      const field = headers[j];
      const val   = cols[j] !== undefined ? cols[j].trim() : '';
      if (val !== '') result[scnid][field] = val;
    }
  }
  return result;
}

// RFC 4180-compliant single-row CSV parser
function parseCSVRow(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

// ─── Normalize ─────────────────────────────────────────────────────────────────
/**
 * Field-type-aware normalization before comparison.
 * Returns a normalized string (or numeric string for amounts).
 */
function normalize(fieldName, value) {
  if (value == null) return '';
  const v = String(value).trim();
  if (!v) return '';

  if (DATE_FIELDS.has(fieldName))   return _normalizeDate(v);
  if (AMOUNT_FIELDS.has(fieldName)) return _normalizeAmount(v);

  if (fieldName === 'shipToCounty') {
    return v.toLowerCase().replace(/\s+county\s*$/i, '').replace(/\s+/g, ' ').trim();
  }

  if (fieldName === 'shipToState') {
    const lower = v.toLowerCase().trim();
    return STATE_MAP[lower] || lower;
  }

  if (ADDRESS_FIELDS.has(fieldName)) {
    // Strip punctuation, sort tokens — order-insensitive street comparison
    return v.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .sort()
      .join(' ');
  }

  if (fieldName === 'invoiceMode') {
    // Canonicalize: non-construction / non_construction → nonconstruction
    return v.toLowerCase().replace(/[-_\s]/g, '');
  }

  // Default: trim, lowercase, collapse whitespace
  return v.toLowerCase().replace(/\s+/g, ' ').trim();
}

function _normalizeDate(v) {
  // MM/DD/YYYY or M/D/YY
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  // YYYY-MM-DD (ISO)
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // Month DD, YYYY
  const months = {
    january:'01', february:'02', march:'03',    april:'04',
    may:'05',     june:'06',     july:'07',     august:'08',
    september:'09', october:'10', november:'11', december:'12'
  };
  m = v.match(/^(\w+)\s+(\d{1,2}),?\s*(\d{4})$/i);
  if (m) {
    const mo = months[m[1].toLowerCase()];
    if (mo) return `${m[3]}-${mo}-${m[2].padStart(2, '0')}`;
  }
  return v.toLowerCase().trim();
}

function _normalizeAmount(v) {
  const stripped = String(v).replace(/[$,\s]/g, '');
  const num = parseFloat(stripped);
  if (isNaN(num)) return '';
  return num.toFixed(2);
}

// ─── Score a single field ──────────────────────────────────────────────────────
/**
 * Returns { correct: bool, weight: number, normPredicted, normGolden }
 * or null when golden is empty (field not labeled — caller should skip).
 */
function scoreField(fieldName, predicted, golden) {
  if (golden == null || golden === '') return null;
  const normGolden = normalize(fieldName, golden);
  if (normGolden === '') return null;
  const normPredicted = normalize(fieldName, predicted != null ? predicted : '');
  return {
    correct:       normPredicted === normGolden,
    weight:        FIELD_WEIGHTS[fieldName] || 1,
    normPredicted,
    normGolden
  };
}

// ─── Evaluate one invoice ──────────────────────────────────────────────────────
/**
 * layerResults = {
 *   docai:  { fieldName: predictedValue, ... },
 *   claude: { fieldName: predictedValue, ... },
 *   vision: { fieldName: predictedValue, ... }
 * }
 * goldenLabels = return value of loadGoldenLabels()
 *
 * Returns { scnid, perField: { fieldName: { docai, claude, vision } } }
 * where each layer entry is a scoreField() result.
 * Fields not in goldenLabels[scnid] are omitted from perField.
 */
function evaluateInvoice(scnid, layerResults, goldenLabels) {
  const golden = goldenLabels[scnid] || {};
  const LAYERS = ['docai', 'claude', 'vision'];
  const perField = {};

  for (const field of Object.keys(golden)) {
    const goldenVal = golden[field];
    if (!goldenVal) continue;

    const fieldScores = {};
    for (const layer of LAYERS) {
      const predicted = ((layerResults[layer] || {})[field]);
      const score = scoreField(field, predicted != null ? predicted : '', goldenVal);
      if (score) fieldScores[layer] = score;
    }
    if (Object.keys(fieldScores).length > 0) perField[field] = fieldScores;
  }

  return { scnid, perField };
}

// ─── Aggregate across all invoices ────────────────────────────────────────────
/**
 * allResults = array of evaluateInvoice() return values.
 *
 * Returns:
 * {
 *   invoiceCount,
 *   layerSummary: {
 *     docai|claude|vision: {
 *       rawAccuracy, weightedAccuracy, taxCriticalAccuracy,
 *       totalFields, correctFields
 *     }
 *   },
 *   perFieldAccuracy: { fieldName: { docai, claude, vision } },
 *   delta: {
 *     claude: { fixed, broke },   // vs docai
 *     vision: { fixed, broke }    // vs docai
 *   }
 * }
 */
function aggregate(allResults) {
  const LAYERS = ['docai', 'claude', 'vision'];

  // Weight-3 fields = "tax critical" in the spec
  const taxCriticalSet = new Set(
    Object.entries(FIELD_WEIGHTS).filter(([, w]) => w >= 3).map(([f]) => f)
  );

  // Running totals per layer
  const totals = {};
  for (const layer of LAYERS) {
    totals[layer] = {
      correct: 0, total: 0,
      weightedCorrect: 0, weightedTotal: 0,
      taxCriticalCorrect: 0, taxCriticalTotal: 0
    };
  }

  // Per-field running totals (aggregated across invoices)
  const perFieldTotals = {};

  for (const { perField } of allResults) {
    for (const [field, layerScores] of Object.entries(perField)) {
      if (!perFieldTotals[field]) {
        perFieldTotals[field] = {};
        for (const layer of LAYERS) perFieldTotals[field][layer] = { correct: 0, total: 0 };
      }

      const isTaxCritical = taxCriticalSet.has(field);

      for (const layer of LAYERS) {
        const score = layerScores[layer];
        if (!score) continue;

        const t = totals[layer];
        t.total++;
        t.weightedTotal += score.weight;
        if (score.correct) {
          t.correct++;
          t.weightedCorrect += score.weight;
        }
        if (isTaxCritical) {
          t.taxCriticalTotal++;
          if (score.correct) t.taxCriticalCorrect++;
        }

        perFieldTotals[field][layer].total++;
        if (score.correct) perFieldTotals[field][layer].correct++;
      }
    }
  }

  // Build layer summary
  const layerSummary = {};
  for (const layer of LAYERS) {
    const t = totals[layer];
    layerSummary[layer] = {
      rawAccuracy:         t.total             ? +(t.correct             / t.total).toFixed(4)             : null,
      weightedAccuracy:    t.weightedTotal      ? +(t.weightedCorrect     / t.weightedTotal).toFixed(4)     : null,
      taxCriticalAccuracy: t.taxCriticalTotal   ? +(t.taxCriticalCorrect  / t.taxCriticalTotal).toFixed(4)  : null,
      totalFields:         t.total,
      correctFields:       t.correct
    };
  }

  // Per-field accuracy across all invoices
  const perFieldAccuracy = {};
  for (const [field, layerTotals] of Object.entries(perFieldTotals)) {
    perFieldAccuracy[field] = {};
    for (const layer of LAYERS) {
      const { correct, total } = layerTotals[layer];
      perFieldAccuracy[field][layer] = total ? +(correct / total).toFixed(4) : null;
    }
  }

  // DELTA: per-field, per-invoice comparison vs Doc AI baseline
  const delta = {
    claude: { fixed: 0, broke: 0 },
    vision: { fixed: 0, broke: 0 }
  };
  for (const { perField } of allResults) {
    for (const layerScores of Object.values(perField)) {
      const docai = layerScores.docai;
      if (!docai) continue;
      for (const challenger of ['claude', 'vision']) {
        const ch = layerScores[challenger];
        if (!ch) continue;
        if (!docai.correct && ch.correct)  delta[challenger].fixed++;
        if (docai.correct  && !ch.correct) delta[challenger].broke++;
      }
    }
  }

  return {
    invoiceCount: allResults.length,
    layerSummary,
    perFieldAccuracy,
    delta
  };
}

module.exports = {
  loadGoldenLabels,
  FIELD_WEIGHTS,
  normalize,
  scoreField,
  evaluateInvoice,
  aggregate
};
