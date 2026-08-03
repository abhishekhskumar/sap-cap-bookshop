/**
 * Shared data-access layer for DocumentIntelligenceService.
 *
 * All seven CAP unbound actions follow the same wire protocol:
 *   POST /api/intelligence/<action>
 *   Content-Type: application/json
 *   Body: JSON-serialised params (or '{}' for no-param actions)
 *
 * CAP wraps every `returns String` action in an OData V4 envelope:
 *   { "@odata.context": "...", "value": "<JSON string>" }
 * The value field is itself a serialised JSON payload — double-unwrap
 * is handled ONCE here; controllers receive a plain JS object/array.
 *
 * Error contract: every function throws an Error with a human-readable
 * message on non-2xx HTTP or JSON parse failure. Controllers catch and
 * surface via sap.m.MessageBox / MessageToast.
 */
sap.ui.define([], function () {
  "use strict";

  const BASE = "/api/intelligence";

  /**
   * POST to a CAP action and unwrap the OData V4 envelope.
   * @param {string} action  - action name, e.g. "listInvoices"
   * @param {object} params  - request body object (default empty)
   * @returns {Promise<*>}   - unwrapped JS value (object, array, or primitive)
   */
  async function _call(action, params = {}) {
    let res;
    try {
      res = await fetch(`${BASE}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params)
      });
    } catch (networkErr) {
      throw new Error(`Network error calling ${action}: ${networkErr.message}`);
    }

    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch (_) {}
      throw new Error(`${action} failed — HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    let env;
    try {
      env = await res.json();
    } catch (parseErr) {
      throw new Error(`${action} returned non-JSON response: ${parseErr.message}`);
    }

    // CAP OData V4 envelope: { "value": "<JSON string>" }
    // All actions declare `returns String`, so env.value is always a string.
    // Guard against rare cases where CAP returns a non-string value directly.
    if (typeof env.value === "string") {
      try {
        return JSON.parse(env.value);
      } catch (innerErr) {
        throw new Error(`${action} value is not valid JSON: ${innerErr.message}`);
      }
    }
    return env.value ?? env;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  return {
    /**
     * Stage 1 — Document AI extraction.
     * @param {{ documentId: string, schemaType: string, invoiceBase64: string, mediaType: string }} p
     */
    extractDocAI: (p) => _call("extractDocAI", p),

    /**
     * Stage 2 — Claude full audit.
     * @param {{ documentId: string, docAIResult: string }} p
     *   docAIResult must be JSON.stringify'd before passing.
     */
    processInvoice: (p) => _call("processInvoice", p),

    /**
     * Stage 3 — Vision audit.
     * @param {{ documentId: string, imageBase64: string, imagePages: string[], docAIResult: string }} p
     */
    auditWithVision: (p) => _call("auditWithVision", p),

    /**
     * List all available invoices in the srv/data folder.
     * @returns {Promise<Array<{ fileName: string, hasAssetData: boolean, scnid: string, supplierName: string }>>}
     */
    listInvoices: () => _call("listInvoices"),

    /**
     * Fetch a raw invoice file as base64.
     * @param {{ fileName: string }} p
     */
    getInvoiceFile: (p) => _call("getInvoiceFile", p),

    /**
     * Call a specific tax engine adapter.
     * @param {{ taxPayload: string, engineName: string }} p
     *   taxPayload must be JSON.stringify'd before passing.
     */
    calculateTaxWithEngine: (p) => _call("calculateTaxWithEngine", p),

    /**
     * Vendor Intelligence aggregation (Step 3).
     * @returns {Promise<{ vendors: object[], meta: object }>}
     */
    getVendorSummary: () => _call("getVendorSummary")
  };
});
