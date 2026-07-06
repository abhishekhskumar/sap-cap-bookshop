using { CatalogService } from './cat-service';

annotate CatalogService.Authors with @PersonalData: {
  EntitySemantics: 'DataSubject',
  DataSubjectRole: 'Author'
} {
  ID   @PersonalData.FieldSemantics: 'DataSubjectID';
  name @PersonalData.IsPotentiallyPersonal;
}

annotate CatalogService.Books with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails'
} {
  author @PersonalData.FieldSemantics: 'DataSubjectID';
}