using my.bookshop from '../db/schema';
using ReviewsAPI from './external/reviews-api';

service CatalogService {

  @odata.draft.enabled
  entity Books as projection on bookshop.Books {
    *,
    author : redirected to Authors
  } actions {
    action restock(quantity: Integer) returns String;
  };

  entity Authors as projection on bookshop.Authors;

  @readonly entity AuditLog as projection on bookshop.AuditLog;

  // Events for async messaging
  event BookRestocked {
    book_id   : Integer;
    title     : String;
    quantity  : Integer;
    newStock  : Integer;
    timestamp : Timestamp;
  }

  event LowStock {
    book_id  : Integer;
    title    : String;
    stock    : Integer;
    timestamp: Timestamp;
  }

  // Expose reviews from external service
  @readonly entity Reviews as projection on ReviewsAPI.Reviews;
  function getBookReview(book_id: Integer) returns {
    rating: Decimal(2,1);
    reviewCount: Integer;
    summary: String;
  };

}

annotate CatalogService.Books with @(
  UI: {
    SelectionFields: [ title, stock ],
    LineItem: [
      { Value: title,       Label: 'Title'    },
      { Value: author.name, Label: 'Author'   },
      { Value: stock,       Label: 'In Stock' },
      {
        $Type       : 'UI.DataFieldWithCriticality',
        Value       : stockStatus,
        Criticality : criticality,
        Label       : 'Availability'
      }
    ],
    Identification: [
      {
        $Type              : 'UI.DataFieldForAction',
        Action             : 'CatalogService.restock',
        Label              : 'Restock',
        InvocationGrouping : #ChangeSet
      }
    ],
    HeaderInfo: {
      TypeName       : 'Book',
      TypeNamePlural : 'Books',
      Title          : { Value: title },
      Description    : { Value: author_ID }
    },
    Facets: [
      {
        $Type  : 'UI.ReferenceFacet',
        ID     : 'BookDetailsFacet',
        Label  : 'Book Details',
        Target : '@UI.FieldGroup#BookDetails'
      },
      {
        $Type  : 'UI.ReferenceFacet',
        ID     : 'StockFacet',
        Label  : 'Stock Information',
        Target : '@UI.FieldGroup#StockInfo'
      }
    ],
    FieldGroup #BookDetails: {
      Data: [
        { Value: ID,        Label: 'Book ID' },
        { Value: title,     Label: 'Title'   },
        { Value: author_ID, Label: 'Author'  }
      ]
    },
    FieldGroup #StockInfo: {
      Data: [
        { Value: stock, Label: 'Stock Count' }
      ]
    }
  }
);

annotate CatalogService.Books with {
  ID          @Core.Immutable;
  title       @mandatory;
  stock       @mandatory;
  stockStatus @Core.Computed;
  criticality @Core.Computed;
}

annotate CatalogService.Books with {
  author @(
    Common: {
      Text            : author.name,
      TextArrangement : #TextOnly,
      ValueList: {
        CollectionPath : 'Authors',
        Parameters     : [
          {
            $Type             : 'Common.ValueListParameterOut',
            LocalDataProperty : author_ID,
            ValueListProperty : 'ID'
          },
          {
            $Type             : 'Common.ValueListParameterDisplayOnly',
            ValueListProperty : 'name'
          }
        ]
      }
    }
  );
}

annotate CatalogService.Authors with @(
  UI.LineItem: [
    { Value: ID,   Label: 'ID'     },
    { Value: name, Label: 'Author' }
  ]
);

annotate CatalogService.Authors with {
  ID   @Core.Immutable;
  name @mandatory;
}

annotate CatalogService.Books actions {
  restock(
    quantity @(
      title               : 'Quantity',
      Common.FieldControl : #Mandatory
    )
  );
}
