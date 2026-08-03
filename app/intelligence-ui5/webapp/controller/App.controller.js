sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "com/sap/usetax/intelligenceui5/service/IntelligenceService"
], function (Controller, MessageToast, IntelligenceService) {
  "use strict";

  return Controller.extend("com.sap.usetax.intelligenceui5.controller.App", {
    onInit: function () {
      IntelligenceService.listInvoices()
        .then(function (invoices) {
          var count = Array.isArray(invoices) ? invoices.length : "?";
          console.log("[IntelligenceService] listInvoices OK —", count, "invoices available");
          MessageToast.show("Service ready — " + count + " invoices available");
        })
        .catch(function (err) {
          console.error("[IntelligenceService] listInvoices failed:", err.message);
          MessageToast.show("Service unreachable: " + err.message);
        });
    }
  });
});
