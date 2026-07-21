'use strict';

let taxRates = {};
try { taxRates = require('../data/tax-rates.json'); } catch (e) { /* rate table absent */ }

const ENGINE_NAME = 'Alternative Engine (illustrative rates — not compliance-grade)';

const COMPONENTS = ['state', 'county', 'city', 'district'];
const LABELS = { state: 'STATE', county: 'COUNTY', city: 'CITY', district: 'DISTRICT' };

module.exports = {
  engineName: ENGINE_NAME,

  calculateTax(payload) {
    const { jurisdiction, lineItems } = payload;
    const state = (jurisdiction.state || '').trim().toUpperCase();
    const city  = (jurisdiction.city  || '').trim().toLowerCase();
    const key   = `${state}|${city}`;

    const rates = (state && city && taxRates[key] && !key.startsWith('_')) ? taxRates[key] : null;

    if (!rates) {
      return {
        engineName: ENGINE_NAME,
        available: false,
        rateKey: key,
        jurisdictionBreakdown: null,
        totalTax: null,
        note: `Jurisdiction "${key}" not in rate table (srv/data/tax-rates.json). Add verified rates to enable calculation.`
      };
    }

    // Per-component totals across all billable lines
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
      return {
        jurisdiction: LABELS[c],
        rate:          rates[c] || 0,
        taxOnLine,
        taxOnFreight,
        total: +(taxOnLine + taxOnFreight).toFixed(2)
      };
    });

    const totalRate = +COMPONENTS.reduce((s, c) => s + (rates[c] || 0), 0).toFixed(3);
    const totalTax  = +rows.reduce((s, r) => s + r.total, 0).toFixed(2);

    return {
      engineName: ENGINE_NAME,
      available: true,
      rateKey: key,
      rates,
      jurisdictionBreakdown: {
        rows,
        totalRate,
        totalTax
      },
      totalTax,
      note: 'Illustrative rates from srv/data/tax-rates.json. All seeded entries are placeholder (0.000%) until replaced with verified values from state/county/city tax authority sources. Not compliance-grade.'
    };
  }
};
