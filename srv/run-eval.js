'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const http = require('http');

const { loadGoldenLabels, evaluateInvoice, aggregate, FIELD_WEIGHTS } = require('./eval');

const SERVER_BASE    = process.env.CAP_SERVER    || 'http://localhost:4004';
const INVOICE_FOLDER = process.env.INVOICE_FOLDER
  || 'C:/Users/abhishek.hs.kumar/Accenture/Agentic AI US Use Tax - Internal team - Merged';

// ── HTTP POST for CAP actions ────────────────────────────────────────────────
// CAP v9 wraps String return values as { "@odata.context":"...","value":"..." }
function capPost(action, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u    = new URL(`${SERVER_BASE}/api/intelligence/${action}`);
    const opts = {
      hostname : u.hostname,
      port     : parseInt(u.port || '4004', 10),
      path     : u.pathname,
      method   : 'POST',
      headers  : {
        'Content-Type'   : 'application/json',
        'Content-Length' : Buffer.byteLength(body)
      }
    };
    const req = http.request(opts, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} on ${action}: ${raw.slice(0, 300)}`));
        }
        try {
          const outer = JSON.parse(raw);
          // Unwrap OData envelope
          const inner = typeof outer.value === 'string' ? JSON.parse(outer.value) : outer;
          resolve(inner);
        } catch (e) {
          reject(new Error(`JSON parse error from ${action}: ${e.message} — raw: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Flatten a layer result into { fieldName: value } for scoring ─────────────
// Doc AI fields only have docAIValue (no correctValue).
// Claude / Vision fields have correctValue (LLM-adjudicated) and docAIValue.
function flattenResult(result, layer) {
  if (!result) return null;
  const isDocAI = (layer === 'docai');
  const flat = {};

  for (const f of (result.fields || [])) {
    flat[f.fieldName] = isDocAI
      ? (f.docAIValue || '')
      : (f.correctValue || f.docAIValue || '');
  }

  // Top-level numeric totals (override any same-named field array entry)
  if (result.invoiceGrossTotal  != null) flat.grossAmount  = result.invoiceGrossTotal;
  if (result.invoiceNetTotal    != null) flat.netAmount    = result.invoiceNetTotal;
  if (result.vendorTaxAmount    != null) flat.taxAmount    = result.vendorTaxAmount;
  if (result.invoiceFreightTotal != null) flat.freight     = result.invoiceFreightTotal;
  if (result.invoiceMode        != null) flat.invoiceMode  = result.invoiceMode;

  return flat;
}

// ── Print accuracy report ────────────────────────────────────────────────────
function printReport(summary, allResults) {
  const { layerSummary, perFieldAccuracy, delta, invoiceCount } = summary;
  const pct = v => v == null ? '  N/A  ' : `${(v * 100).toFixed(1).padStart(5)}%`;
  const SEP = '═'.repeat(62);

  console.log(`\n${SEP}`);
  console.log(`  EVAL BASELINE  —  ${invoiceCount} invoice(s)`);
  console.log(SEP);

  const hdr = 'Layer         Raw     Weighted  TaxCrit   OK / Total';
  console.log('\n' + hdr);
  console.log('─'.repeat(hdr.length));
  for (const layer of ['docai', 'claude', 'vision']) {
    const s = layerSummary[layer];
    if (!s || s.totalFields === 0) {
      console.log(`${layer.padEnd(13)} (no scored fields)`);
      continue;
    }
    console.log(
      `${layer.padEnd(13)} ${pct(s.rawAccuracy)}  ${pct(s.weightedAccuracy)}  ` +
      `${pct(s.taxCriticalAccuracy)}  ${s.correctFields} / ${s.totalFields}`
    );
  }

  const dc = delta.claude, dv = delta.vision;
  console.log('\nDelta vs Doc AI:');
  console.log(`  Claude  fixed=${dc.fixed}  broke=${dc.broke}  net=${dc.fixed - dc.broke}`);
  console.log(`  Vision  fixed=${dv.fixed}  broke=${dv.broke}  net=${dv.fixed - dv.broke}`);

  // Per-field table sorted by weight desc, then alpha
  const fields = Object.keys(perFieldAccuracy).sort((a, b) => {
    const wa = FIELD_WEIGHTS[a] || 1, wb = FIELD_WEIGHTS[b] || 1;
    return wb - wa || a.localeCompare(b);
  });

  console.log('\nPer-field accuracy  (✓=correct  ✗=wrong  –=not scored):');
  const fhdr = 'Field                    w   DocAI  Claude  Vision  Scored(n)';
  console.log(fhdr);
  console.log('─'.repeat(fhdr.length));
  for (const field of fields) {
    const fa = perFieldAccuracy[field];
    const w  = FIELD_WEIGHTS[field] || 1;
    const cell = v => (v == null ? ' – ' : v >= 1 ? ' ✓ ' : ' ✗ ');
    // count total scored across layers (max is invoiceCount)
    const n = Object.values(allResults).reduce((s, inv) => {
      const sc = inv.perField[field];
      return s + (sc && sc.docai ? 1 : 0);
    }, 0);
    console.log(
      `${field.padEnd(24)}  ${String(w).padStart(1)}  ${cell(fa.docai)}    ${cell(fa.claude)}    ${cell(fa.vision)}    ${n}`
    );
  }

  // Per-invoice detail
  console.log('\nPer-invoice field detail:');
  for (const inv of allResults) {
    console.log(`\n  SCNID: ${inv.scnid}`);
    for (const [field, scores] of Object.entries(inv.perField)) {
      const fmt = s => s
        ? (s.correct ? `✓ "${s.normPredicted}"` : `✗  got:"${s.normPredicted}"  want:"${s.normGolden}"`)
        : '–';
      console.log(`    ${field.padEnd(24)}  docai: ${fmt(scores.docai)}`);
      if (scores.claude) console.log(`    ${''.padEnd(24)}  claude:${fmt(scores.claude)}`);
      if (scores.vision) console.log(`    ${''.padEnd(24)}  vision:${fmt(scores.vision)}`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const golden = loadGoldenLabels();
  const scnids = Object.keys(golden);
  console.log(`Loaded ${scnids.length} golden label row(s): ${scnids.join(', ')}`);

  const allResults = [];

  for (const scnid of scnids) {
    const pdfPath = path.join(INVOICE_FOLDER, `${scnid}.pdf`);
    if (!fs.existsSync(pdfPath)) {
      console.log(`\n[SKIP] ${scnid} — PDF not found (${pdfPath})`);
      continue;
    }

    console.log(`\n[RUN ] ${scnid}`);
    const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');

    let docaiResult = null, claudeResult = null, visionResult = null;

    // Layer 1 — Doc AI
    try {
      docaiResult = await capPost('extractDocAI', {
        documentId   : scnid,
        schemaType   : 'auto',
        invoiceBase64: pdfBase64,
        mediaType    : 'application/pdf'
      });
      console.log(`  docai  OK  mode=${docaiResult.invoiceMode}  net=${docaiResult.invoiceNetTotal}`);
    } catch (err) {
      console.error(`  docai  FAIL: ${err.message}`);
    }

    // Layer 2 — Claude text audit
    if (docaiResult) {
      try {
        claudeResult = await capPost('processInvoice', {
          documentId : scnid,
          docAIResult: JSON.stringify(docaiResult)
        });
        console.log(`  claude OK  mode=${claudeResult.invoiceMode}  net=${claudeResult.invoiceNetTotal}`);
      } catch (err) {
        console.error(`  claude FAIL: ${err.message}`);
      }
    }

    // Layer 3 — Vision audit (requires PNG page images; PDF passed as single-page fallback)
    const prevForVision = claudeResult || docaiResult;
    if (prevForVision) {
      try {
        visionResult = await capPost('auditWithVision', {
          documentId : scnid,
          imageBase64: pdfBase64,
          imagePages : [],
          docAIResult: JSON.stringify(prevForVision)
        });
        console.log(`  vision OK  mode=${visionResult.invoiceMode}  net=${visionResult.invoiceNetTotal}`);
      } catch (err) {
        console.warn(`  vision FAIL (PDF→PNG conversion unavailable): ${err.message.slice(0, 120)}`);
      }
    }

    const layerResults = {
      docai : flattenResult(docaiResult,  'docai'),
      claude: flattenResult(claudeResult, 'claude'),
      vision: flattenResult(visionResult, 'vision')
    };

    allResults.push(evaluateInvoice(scnid, layerResults, golden));
  }

  if (allResults.length === 0) {
    console.log('\nNo invoices scored — verify PDF paths and that the CAP server is running.');
    return;
  }

  const summary = aggregate(allResults);
  printReport(summary, allResults);
}

main().catch(err => { console.error('Fatal:', err.stack); process.exit(1); });
