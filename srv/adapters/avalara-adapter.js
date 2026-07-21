'use strict';

const ENGINE_NAME = 'Avalara AvaTax';

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
          + 'AvaTax REST v2 accepts this identical payload shape with field mapping. '
          + 'In production, swap this adapter to route to Avalara for nexus-aware calculations, '
          + 'exemption certificate management, and multi-jurisdiction sourcing rules.'
    };
  }
};
