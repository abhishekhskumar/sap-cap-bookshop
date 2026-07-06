using my.bookshop from './schema';

extend my.bookshop.Books with {
  isbn           : String(17);
  pageCount      : Integer;
  language       : String(2) default 'EN';
  price          : Decimal(10,2);
  currency       : String(3) default 'USD';
  approvalStatus : String enum { pending; approved; rejected } default 'pending';
  reviewedBy     : String;
  reviewedAt     : DateTime;
}
