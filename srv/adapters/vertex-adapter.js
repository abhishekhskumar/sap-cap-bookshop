'use strict';

/**
 * TaxEngineAdapter interface (implemented by every adapter) — Vertex O-Series v9.0.21 shape:
 *   calculateTax(payload) → {
 *     engineName:  string,
 *     available:   boolean,
 *     subTotal:    number | null,   // sum of line netAmounts
 *     total:       number | null,   // subTotal + totalTax
 *     totalTax:    number | null,   // document-level total tax
 *     lineItems: [{                 // null when not connected
 *       description: string,
 *       netAmount:   number,
 *       freightShare: number,
 *       taxes: [{
 *         jurisdiction:   { jurisdictionType: 'STATE'|'COUNTY'|'CITY'|'DISTRICT', value: string },
 *         effectiveRate:  number,   // decimal (0.065 = 6.5%)
 *         nominalRate:    number,
 *         taxable:        number,
 *         calculatedTax:  number,
 *         taxResult:      'TAXABLE',
 *         taxType:        'CONSUMERS_USE',
 *         situs:          'DESTINATION',
 *         impositionType: { value: 'General Sales and Use Tax' }
 *       }],
 *       totalTax: number
 *     }] | null,
 *     note: string
 *   }
 *
 * payload shape (from _buildTaxPayload):
 *   { freightHandling: 'distinct-per-line',
 *     freightSeparatelyStated: boolean,  // five-factor input: true when freight is a distinct invoice element
 *     fobTerms: string|null,             // five-factor input: e.g. "F.O.B. Ship Point"; null when not stated
 *     lineItems:[{description,unspscCode,netAmount,freightShare,taxableTotal}],
 *     jurisdiction:{state,county,city,postalCode},
 *     invoiceMode, totals:{net,freight,gross} }
 */

const ENGINE_NAME = 'Vertex';

module.exports = {
  engineName: ENGINE_NAME,

  calculateTax(payload) {
    return {
      engineName: ENGINE_NAME,
      status:     'production',
      available:  false,
      subTotal:   null,
      total:      null,
      totalTax:   null,
      lineItems:  null,
      note: 'Production engine — connected in deployed Phase 1. '
          + 'In production this identical payload is submitted to Vertex O Series, '
          + 'returning authoritative jurisdiction rates, taxability determinations, '
          + 'sourcing rules, and exemption certificate handling in the same lineItems[].taxes[] shape.'
    };
  }
};
