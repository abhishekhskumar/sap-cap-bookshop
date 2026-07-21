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

const ENGINE_NAME = 'Vertex (Production)';

module.exports = {
  engineName: ENGINE_NAME,

  calculateTax(payload) {
    return {
      engineName: ENGINE_NAME,
      available: false,
      jurisdictionBreakdown: null,
      totalTax: null,
      note: 'Production Vertex O Series API — not connected in this POC. '
          + 'In production this identical payload would be submitted to Vertex, '
          + 'returning authoritative jurisdiction rates, taxability determinations, '
          + 'sourcing rules, and exemption certificate handling.'
    };
  }
};
