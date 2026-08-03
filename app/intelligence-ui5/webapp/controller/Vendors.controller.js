sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/ui/model/json/JSONModel",
  "com/sap/usetax/intelligenceui5/service/IntelligenceService"
], function (Controller, MessageToast, JSONModel, IntelligenceService) {
  "use strict";

  return Controller.extend("com.sap.usetax.intelligenceui5.controller.Vendors", {

    onInit: function () {
      var oModel = new JSONModel({ vendors: [], busy: true });
      this.getView().setModel(oModel);

      IntelligenceService.getVendorSummary()
        .then(function (summary) {
          // getVendorSummary returns { vendors: [...], meta: {...} } — adjust if different
          var vendors = summary.vendors || summary || [];
          oModel.setProperty("/vendors", vendors);
          oModel.setProperty("/busy", false);
          MessageToast.show(vendors.length + " vendors loaded");
        })
        .catch(function (err) {
          oModel.setProperty("/busy", false);
          MessageToast.show("Vendor summary failed: " + err.message);
        });
    },

    onNavBack: function () {
      this.getOwnerComponent().getRouter().navTo("main");
    }

  });
});