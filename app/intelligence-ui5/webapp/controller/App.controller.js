sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "com/sap/usetax/intelligenceui5/service/IntelligenceService"
], function (Controller, MessageToast, JSONModel, Filter, FilterOperator, IntelligenceService) {
  "use strict";

  return Controller.extend("com.sap.usetax.intelligenceui5.controller.App", {

    onInit: function () {
      var oModel = new JSONModel({ invoices: [], selected: {}, busy: true });
      this.getView().setModel(oModel);

      IntelligenceService.listInvoices()
        .then(function (invoices) {
          oModel.setProperty("/invoices", invoices);
          oModel.setProperty("/busy", false);
          MessageToast.show(invoices.length + " invoices loaded");
        })
        .catch(function (err) {
          oModel.setProperty("/busy", false);
          MessageToast.show("Service unreachable: " + err.message);
        });
    },

    onInvoicePress: function (oEvent) {
      var oInvoice = oEvent.getSource().getBindingContext().getObject();
      this.getView().getModel().setProperty("/selected", oInvoice);
    },

    onSearchInvoices: function (oEvent) {
      var sQuery = oEvent.getParameter("newValue");
      if (sQuery === undefined) {
        sQuery = oEvent.getParameter("query") || "";
      }

      var oList = this.byId("invoiceList");
      if (!oList) { return; }
      var oBinding = oList.getBinding("items");
      if (!oBinding) { return; }

      if (sQuery) {
        var oFilter = new Filter({
          filters: [
            new Filter("supplierName", FilterOperator.Contains, sQuery),
            new Filter("fileName", FilterOperator.Contains, sQuery)
          ],
          and: false
        });
        oBinding.filter([oFilter]);
      } else {
        oBinding.filter([]);
      }
    }

  });
});