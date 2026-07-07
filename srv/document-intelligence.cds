namespace usetax.intelligence;

service DocumentIntelligenceService @(path: '/api/intelligence') {

  action extractDocAI(
    documentId : String,
    schemaType : String enum { construction; non_construction; indexing; auto },
    invoiceBase64 : LargeString,
    mediaType : String
  ) returns String;

  action processInvoice(
    documentId : String,
    schemaType : String enum { construction; non_construction; indexing; auto },
    invoiceBase64 : LargeString,
    mediaType : String
  ) returns String;
}
