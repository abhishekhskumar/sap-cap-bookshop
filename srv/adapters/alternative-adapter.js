'use strict';

let taxRates = {};
try { taxRates = require('../data/tax-rates.json'); } catch (e) { /* rate table absent */ }

const ENGINE_NAME = 'SalesTaxZip';

const COMPONENTS = ['state', 'county', 'city', 'district'];
const JURISDICTION_TYPES = { state: 'STATE', county: 'COUNTY', city: 'CITY', district: 'DISTRICT' };

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
  // API shape: { data: { city, state, rates: { state, county, city, local, combined } } }
  // Rates are decimal (0.06 = 6%) — multiply by 100 to match the % convention
  const r = body && body.data && body.data.rates;
  if (!r || typeof r.state === 'undefined') {
    _zipCache.set(zip, null);
    return null;
  }

  const city_pct     = +((parseFloat(r.city)    || 0) * 100).toFixed(4);
  const district_pct = +((parseFloat(r.local)   || 0) * 100).toFixed(4);
  const rates = {
    state:    +((parseFloat(r.state)    || 0) * 100).toFixed(4),
    county:   +((parseFloat(r.county)   || 0) * 100).toFixed(4),
    city:     city_pct,
    // When local ≈ city the API double-reports the same rate — suppress the duplicate
    district: Math.abs(district_pct - city_pct) < 0.001 ? 0 : district_pct,
    combined: +((parseFloat(r.combined) || 0) * 100).toFixed(4),
    // Real jurisdiction names from the API response — not fabricated
    _apiCity:  (body.data.city  || '').toUpperCase().trim(),
    _apiState: (body.data.state || '').toUpperCase().trim()
  };
  _zipCache.set(zip, rates);
  return rates;
}

// Returns the real jurisdiction name for a rate tier.
// Prefers API-returned names (city, state abbreviation from the STZ response).
// For county: STZ API does not return county name — uses extracted shipToCounty if present.
// Never fabricates a name; returns the type label as fallback.
function _jurisdictionName(component, jInfo, rates) {
  switch (component) {
    case 'state':
      return (rates && rates._apiState) || (jInfo.state || 'STATE').toUpperCase();
    case 'county': {
      const cn = (jInfo.county || '').trim().toUpperCase();
      return cn || 'COUNTY';
    }
    case 'city':
      return (rates && rates._apiCity) || (jInfo.city || 'CITY').toUpperCase();
    case 'district':
      return 'LOCAL DISTRICT';
    default:
      return component.toUpperCase();
  }
}

// Returns Vertex O-Series shaped result: per-line taxes[], document subTotal/total/totalTax,
// plus a document-level jurisdictions[] summary with non-zero tiers only.
function computeBreakdown(rates, lineItems, jInfo) {
  const resultLines = lineItems.map(li => {
    const net     = +(parseFloat(li.netAmount != null ? li.netAmount : (li.amount || 0)) || 0).toFixed(2);
    const freight = +(parseFloat(li.freightShare || 0) || 0).toFixed(2);
    const taxable = +(+net + +freight).toFixed(2);

    // Only include tiers with a non-zero rate — zero-rate tiers (e.g. county=0) add no information
    const taxes = COMPONENTS
      .filter(c => (rates[c] || 0) > 0)
      .map(c => {
        const ratePct  = rates[c];
        const effRate  = +(ratePct / 100).toFixed(6);
        const calcTax  = +(taxable * effRate).toFixed(2);
        return {
          jurisdiction:   { jurisdictionType: JURISDICTION_TYPES[c], value: _jurisdictionName(c, jInfo, rates) },
          effectiveRate:  effRate,
          nominalRate:    effRate,
          taxable,
          calculatedTax:  Math.abs(calcTax) < 1e-6 ? 0 : calcTax,
          taxResult:      'TAXABLE',
          taxType:        'CONSUMERS_USE',
          situs:          'DESTINATION',
          impositionType: { value: 'General Sales and Use Tax' }
        };
      });

    const totalTax = +taxes.reduce((s, t) => s + t.calculatedTax, 0).toFixed(2);
    return { description: li.description || '', netAmount: +net, freightShare: +freight, taxes, totalTax };
  });

  const docTotalTax = +resultLines.reduce((s, li) => s + li.totalTax, 0).toFixed(2);
  const subTotal    = +resultLines.reduce((s, li) => s + li.netAmount, 0).toFixed(2);
  const total       = +(subTotal + docTotalTax).toFixed(2);
  // Total taxable base = Σ(net + freight per line) — matches what each line's tax was computed on
  const docTaxable  = +resultLines.reduce((s, li) => s + li.netAmount + li.freightShare, 0).toFixed(2);

  // Document-level jurisdiction summary — Vertex {type, name, rate, taxableAmount, taxAmount} shape
  const jurisdictions = COMPONENTS
    .filter(c => (rates[c] || 0) > 0)
    .map(c => ({
      type:          JURISDICTION_TYPES[c],
      name:          _jurisdictionName(c, jInfo, rates),
      rate:          rates[c],                                    // percentage (e.g. 6.25)
      taxableAmount: docTaxable,
      taxAmount:     +(docTaxable * (rates[c] / 100)).toFixed(2) // document-level computation
    }));

  return { lineItems: resultLines, subTotal, total, totalTax: docTotalTax, docTaxable, jurisdictions };
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
          const bd = computeBreakdown(apiRates, lineItems, jurisdiction);
          return {
            engineName:    ENGINE_NAME,
            available:     true,
            rateSource:    'api',
            rateKey:       zip,
            subTotal:      bd.subTotal,
            total:         bd.total,
            totalTax:      bd.totalTax,
            docTaxable:    bd.docTaxable,
            jurisdictions: bd.jurisdictions,
            combinedRate:  apiRates.combined,
            lineItems:     bd.lineItems,
            note: 'Rates: SalesTaxZip (live, ZIP-level) · Production engine: Vertex (full-address jurisdiction + product-specific taxability). Not compliance-grade — verify with your state DOR or a licensed CPA before use. Data © SalesTaxZip.'
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
      const bd = computeBreakdown(tableRates, lineItems, jurisdiction);
      return {
        engineName:    ENGINE_NAME,
        available:     true,
        rateSource:    'local',
        rateKey:       tableKey,
        subTotal:      bd.subTotal,
        total:         bd.total,
        totalTax:      bd.totalTax,
        docTaxable:    bd.docTaxable,
        jurisdictions: bd.jurisdictions,
        combinedRate:  tableRates.combined,
        lineItems:     bd.lineItems,
        note: 'Rates: SalesTaxZip (local table fallback) · Production engine: Vertex (full-address jurisdiction + product-specific taxability). ZIP lookup unavailable — fell back to srv/data/tax-rates.json. All seeded entries are placeholder (0.000%) until replaced with verified values. Not compliance-grade.'
      };
    }

    // ── 3. No rate data available ───────────────────────────────────────────
    const keyDesc = zip || tableKey || '(no ZIP or city)';
    return {
      engineName:    ENGINE_NAME,
      available:     false,
      rateKey:       keyDesc,
      subTotal:      null,
      total:         null,
      totalTax:      null,
      docTaxable:    null,
      jurisdictions: [],
      combinedRate:  null,
      lineItems:     null,
      note: zip
        ? `ZIP "${zip}" not found via SalesTaxZip and not in local rate table. Add it to srv/data/tax-rates.json or verify the ship-to ZIP.`
        : `No postalCode in payload and jurisdiction "${tableKey}" not in local rate table. Requires Vertex or a verified rate source.`
    };
  }
};
