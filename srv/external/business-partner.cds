// Simulates importing from SAP Business Accelerator Hub
// In a real project: cds import API_BUSINESS_PARTNER.edmx --as cds
@cds.external
service API_BUSINESS_PARTNER {

  @cds.persistence.skip
  entity A_BusinessPartner {
    key BusinessPartner     : String(10);
    BusinessPartnerFullName : String(81);
    BusinessPartnerCategory : String(1);
    Industry                : String(10);
    Country                 : String(3);
  }
}
