using { CatalogService } from './cat-service';

annotate CatalogService.Books with @changelog: [title] {
  title  @changelog;
  stock  @changelog;
  price  @changelog;
  author @changelog: [author.name];
}
