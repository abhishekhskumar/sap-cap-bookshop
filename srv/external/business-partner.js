// Mock — simulates S/4HANA Business Partner API
// In production, this file doesn't exist — CAP calls the real S/4HANA

const mockPartners = [
  { BusinessPartner: '1000001', BusinessPartnerFullName: 'Penguin Random House', BusinessPartnerCategory: '2', Industry: 'PUBL', Country: 'US' },
  { BusinessPartner: '1000002', BusinessPartnerFullName: 'HarperCollins Publishers', BusinessPartnerCategory: '2', Industry: 'PUBL', Country: 'US' },
  { BusinessPartner: '1000003', BusinessPartnerFullName: 'Hachette Book Group', BusinessPartnerCategory: '2', Industry: 'PUBL', Country: 'FR' }
];

module.exports = (srv) => {
  srv.on('READ', 'A_BusinessPartner', (req) => {
    return mockPartners;
  });
};
