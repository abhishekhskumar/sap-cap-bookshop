'use strict';

const ENGINE_NAME = 'Thomson Reuters ONESOURCE';

module.exports = {
  engineName: ENGINE_NAME,

  calculateTax(payload) {
    return {
      engineName: ENGINE_NAME,
      status: 'pluggable',
      available: false,
      jurisdictionBreakdown: null,
      totalTax: null,
      note: 'Enterprise alternative — pluggable via same payload. '
          + 'ONESOURCE Indirect Tax accepts equivalent jurisdiction and line-item data. '
          + 'In production, swap this adapter to route to ONESOURCE for global VAT/GST, '
          + 'customs duty, and US sales tax with full audit trail support.'
    };
  }
};
