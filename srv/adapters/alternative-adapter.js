'use strict';

let taxRates = {};
try { taxRates = require('../data/tax-rates.json'); } catch (e) { /* rate table absent */ }

const ENGINE_NAME = 'SalesTaxZip';

const COMPONENTS = ['state', 'county', 'city', 'district'];
const LABELS = { state: 'STATE', county: 'COUNTY', city: 'CITY', district: 'DISTRICT' };

// In-memory rate cache keyed by ZIP — respects the 100/hr free-tier limit
const _zipCache = new Map();

async function fetchRateByZip(zip) {
  if (_zipCache.has(zip)) return _zipCache.get(zip);

  const url = `https://salestaxzip.com/api/v1/rate/${encodeURIComponent(zip)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

  if (!res.ok) {
    // 404 = ZIP unknown, 429 = rate-limited — both are expected failures
    _zipCache.set(zip, null);
    return null;
  }

  const body = await res.json();
  // API shape: { data: { rates: { state, county, city, local, combined } } }
  // Rates are decimal (0.06 = 6%) — multiply by 100 to match the % convention
  // used by computeBreakdown (which divides by 100 internally).
  const r = body && body.data && body.data.rates;
  if (!r || typeof r.state === 'undefined') {
    _zipCache.set(zip, null);
    return null;
  }

  const rates = {
    state:    +((parseFloat(r.state)    || 0) * 100).toFixed(4),
    county:   +((parseFloat(r.county)   || 0) * 100).toFixed(4),
    city:     +((parseFloat(r.city)     || 0) * 100).toFixed(4),
    district: +((parseFloat(r.local)    || 0) * 100).toFixed(4),  // SalesTaxZip calls it "local"
    combined: +((parseFloat(r.combined) || 0) * 100).toFixed(4)
  };
  _zipCache.set(zip, rates);
  return rates;
}

function computeBreakdown(rates, lineItems) {
  let lineTotals = {}, freightTotals = {};
  COMPONENTS.forEach(c => { lineTotals[c] = 0; freightTotals[c] = 0; });

  lineItems.forEach(li => {
    COMPONENTS.forEach(c => {
      lineTotals[c]    += +(li.amount      * (rates[c] || 0) / 100).toFixed(2);
      freightTotals[c] += +(li.freightShare * (rates[c] || 0) / 100).toFixed(2);
    });
  });

  const rows = COMPONENTS.map(c => {
    const taxOnLine    = +lineTotals[c].toFixed(2);
    const taxOnFreight = +freightTotals[c].toFixed(2);
    return { jurisdiction: LABELS[c], rate: rates[c] || 0, taxOnLine, taxOnFreight, total: +(taxOnLine + taxOnFreight).toFixed(2) };
  });

  const totalRate = +COMPONENTS.reduce((s, c) => s + (rates[c] || 0), 0).toFixed(3);
  const totalTax  = +rows.reduce((s, r) => s + r.total, 0).toFixed(2);
  return { rows, totalRate, totalTax };
}

module.exports = {
  engineName: ENGINE_NAME,

  async calculateTax(payload) {
    const { jurisdiction, lineItems } = payload;
    const zip   = (jurisdiction.postalCode || '').trim().replace(/\D/g, '').slice(0, 5);
    const state = (jurisdiction.state || '').trim().toUpperCase();
    const city  = (jurisdiction.city  || '').trim().toLowerCase();

    // ── 1. Try live ZIP lookup ──────────────────────────────────────────────
    if (zip) {
      try {
        const apiRates = await fetchRateByZip(zip);
        if (apiRates) {
          const bd = computeBreakdown(apiRates, lineItems);
          return {
            engineName: ENGINE_NAME,
            available: true,
            rateSource: 'api',
            rateKey: zip,
            rates: apiRates,
            jurisdictionBreakdown: bd,
            totalTax: bd.totalTax,
            note: 'Rates fetched live from SalesTaxZip (salestaxzip.com). Estimation only — not compliance-grade. Verify with your state DOR or a licensed CPA before use. Data © SalesTaxZip.'
          };
        }
        // API returned 404/429 or empty — fall through to local table
      } catch (_) {
        // Network error, timeout, parse failure — fall through silently
      }
    }

    // ── 2. Fallback: local rate table (srv/data/tax-rates.json) ────────────
    const tableKey = `${state}|${city}`;
    const tableRates = (state && city && taxRates[tableKey] && !tableKey.startsWith('_')) ? taxRates[tableKey] : null;
    if (tableRates) {
      const bd = computeBreakdown(tableRates, lineItems);
      return {
        engineName: ENGINE_NAME,
        available: true,
        rateSource: 'local',
        rateKey: tableKey,
        rates: tableRates,
        jurisdictionBreakdown: bd,
        totalTax: bd.totalTax,
        note: 'ZIP lookup unavailable — fell back to srv/data/tax-rates.json. All seeded entries are placeholder (0.000%) until replaced with verified values. Not compliance-grade.'
      };
    }

    // ── 3. No rate data available ───────────────────────────────────────────
    const keyDesc = zip || tableKey || '(no ZIP or city)';
    return {
      engineName: ENGINE_NAME,
      available: false,
      rateKey: keyDesc,
      jurisdictionBreakdown: null,
      totalTax: null,
      note: zip
        ? `ZIP "${zip}" not found via SalesTaxZip and not in local rate table. Add it to srv/data/tax-rates.json or verify the ship-to ZIP.`
        : `No postalCode in payload and jurisdiction "${tableKey}" not in local rate table. Requires Vertex or a verified rate source.`
    };
  }
};
