service ReviewsAPI {
  entity Reviews {
    key book_id : Integer;
    rating      : Decimal(2,1);
    reviewCount : Integer;
    summary     : String;
  }
}
