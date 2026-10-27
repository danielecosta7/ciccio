// Chiavi pubbliche delle release di companion e app desktop (Ed25519, i 32 byte della chiave in base64).
// I programmi compilati da questo codice installano un aggiornamento solo se il manifest e il file sono
// firmati con la chiave privata corrispondente: il segreto CICCIO_RELEASE_KEY delle GitHub Actions
// (.github/workflows/release.yml). Così un server di Ciccio compromesso non può far installare niente ai PC.
//
// Formato fisso, una chiave per riga tra apici: questo file lo leggono anche desktop/src-tauri/src/update.rs
// (include_str!) e scripts/release-key.mjs. Più chiavi = rotazione (docs/tecnico.md, «Firma delle release»).
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  'HmYlEJYkToDYZknewJtwqnaTugFia/iKz4W08WFavXc=',
];
