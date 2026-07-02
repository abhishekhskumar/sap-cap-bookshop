namespace my.bookshop;
using { managed } from '@sap/cds/common';

entity Books : managed {
  key ID : Integer;
  title  : String(111);
  stock  : Integer;
  virtual stockStatus : String;
  virtual criticality : Integer;
  author : Association to Authors;
}

entity Authors : managed {
  key ID : Integer;
  name  : String(111);
  books : Association to many Books on books.author = $self;
}
