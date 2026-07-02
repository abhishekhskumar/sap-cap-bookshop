using my.bookshop from '../db/schema';

service CatalogService {
  entity Books   as projection on bookshop.Books;
  entity Authors as projection on bookshop.Authors;

  action restock(book: UUID, quantity: Integer) returns String;
}

annotate CatalogService.Books with @(
  UI: {
    LineItem: [
      { Value: title,       Label: 'Title' },
      { Value: author.name, Label: 'Author' },
      { Value: stock,       Label: 'In Stock' },
      { Value: stockStatus, Label: 'Availability', Criticality: criticality }
    ],
    SelectionFields: [ title, stock ],
    HeaderInfo: {
      TypeName: 'Book',
      TypeNamePlural: 'Books',
      Title:       { Value: title },
      Description: { Value: author.name }
    },
    Facets: [
      { $Type: 'UI.ReferenceFacet', Label: 'Book Details', Target: '@UI.FieldGroup#Main' }
    ],
    FieldGroup #Main: {
      Data: [
        { Value: title },
        { Value: author.name, Label: 'Author' },
        { Value: stock },
        { Value: stockStatus, Criticality: criticality }
      ]
    }
  }
);
