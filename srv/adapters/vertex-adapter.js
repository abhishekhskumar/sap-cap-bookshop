'use strict';

/**
 * TaxEngineAdapter interface (implemented by every adapter):
 *   calculateTax(payload) → {
 *     engineName: string,
 *     available: boolean,
 *     jurisdictionBreakdown: { rows:[{jurisdiction,rate,taxOnLine,taxOnFreight,total}], totalRate, totalTax } | null,
 *     totalTax: number | null,
 *     note: string
 *   }
 *
 * payload shape (from _buildTaxPayload):
 *   { lineItems:[{description,unspscCode,amount,freightShare,taxableAmount}],
 *     jurisdiction:{state,county,city,postalCode},
 *     invoiceMode, totals:{net,freight,gross} }
 */

const ENGINE_NAME = 'Vertex';

module.exports = {
  engineName: ENGINE_NAME,

  calculateTax(payload) {
    return {
      engineName: ENGINE_NAME,
      status: 'production',
      available: false,
      jurisdictionBreakdown: null,
      totalTax: null,
      note: 'Production engine — connected in deployed Phase 1. '
          + 'In production this identical payload is submitted to Vertex O Series, '
          + 'returning authoritative jurisdiction rates, taxability determinations, '
          + 'sourcing rules, and exemption certificate handling.'
    };
  }
};
