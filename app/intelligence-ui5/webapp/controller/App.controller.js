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
      var oModel = new JSONModel({ invoices: [], selected: {}, extracted: null, extracting: false, busy: true });
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
      var oModel = this.getView().getModel();

      oModel.setProperty("/selected", oInvoice);
      oModel.setProperty("/extracting", true);
      oModel.setProperty("/extracted", null);

      IntelligenceService.getInvoiceFile({ fileName: oInvoice.fileName })
        .then(function (fileResult) {
          // getInvoiceFile may return the base64 STRING directly, or an object
          var base64;
          if (typeof fileResult === "string") {
            base64 = fileResult;
          } else if (fileResult) {
            base64 = fileResult.base64 || fileResult.content || fileResult.value || fileResult.data;
          }
          console.log("[DEBUG] base64 length:", base64 ? base64.length : "UNDEFINED");

          if (!base64) {
            throw new Error("No PDF content received from getInvoiceFile");
          }

          return IntelligenceService.extractDocAI({
            documentId: oInvoice.scnid,
            invoiceBase64: base64,
            mediaType: "application/pdf"
          });
        })
        .then(function (result) {
          console.log("[DEBUG] EXTRACTION RESULT:", result);
          console.log("[DEBUG] fields[0]:", result.fields ? result.fields[0] : "no fields");
          console.log("[DEBUG] canonicalVendorName:", result.canonicalVendorName);
          console.log("[DEBUG] grossAmount:", result.grossAmount);
          oModel.setProperty("/extracted", result);
          oModel.setProperty("/extracting", false);
          MessageToast.show("Extraction complete");
        })
        .catch(function (err) {
          console.error("[DEBUG] FAILED:", err);
          oModel.setProperty("/extracting", false);
          MessageToast.show("Extraction failed: " + err.message);
        });
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
    },

    onOpenVendors: function () {
      this.getOwnerComponent().getRouter().navTo("vendors");
    }

  });
});