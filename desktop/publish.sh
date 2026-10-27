#!/usr/bin/env bash
# Pubblica a mano una versione dell'app su un server, senza passare da una release di GitHub
# (il modo normale è la release firmata: tag vX.Y.Z, poi deploy/fetch-release.sh sul server).
# Le app collegate la scaricano e si aggiornano da sole (quando la finestra è chiusa o ridotta, o all'uscita)
# solo se è firmata con la chiave delle release.
#   1. alza version in desktop/src-tauri/Cargo.toml
#   2. scarica l'installer Windows dall'artefatto della CI «App desktop» (stessa versione) in
#      dist/desktop/Ciccio-windows-setup.exe
#   3. bash desktop/publish.sh             (sul Mac: compila il Mac, scrive e firma app.json, copia sul server)
#      DEST=utente@server:.ciccio/downloads    cartella di destinazione sul server (obbligatoria)
#      CICCIO_RELEASE_KEY_FILE=<file>          chiave privata delle release (PEM, obbligatoria: senza non si pubblica)
#      SKIP_BUILD=1                         usa i file già compilati in dist/desktop
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist/desktop
dest="${DEST:?Imposta DEST, es. DEST=ciccio@server:.ciccio/downloads}"
[[ -n "${CICCIO_RELEASE_KEY_FILE:-}${CICCIO_RELEASE_KEY:-}" ]] || { echo "Manca CICCIO_RELEASE_KEY_FILE (la chiave privata delle release): senza firma le app rifiutano l'aggiornamento." >&2; exit 1; }
version=$(sed -n 's/^version = "\(.*\)"/\1/p' desktop/src-tauri/Cargo.toml | head -1)

[[ -z "${SKIP_BUILD:-}" ]] && bash desktop/build.sh
for f in Ciccio-mac.zip Ciccio-mac.dmg Ciccio-windows-setup.exe; do
  [[ -f "$out/$f" ]] || { echo "Manca $out/$f (l'installer Windows è l'artefatto della CI «App desktop»)." >&2; exit 1; }
done

# Manifest con sha256 e firma di ogni file, la sua firma e le firme separate (<file>.sig): come la release.
node scripts/release-key.mjs manifest app "$version" "$out" \
  darwin-arm64=Ciccio-mac.zip win32-x64=Ciccio-windows-setup.exe \
  --installer darwin-arm64=Ciccio-mac.dmg --installer win32-x64=Ciccio-windows-setup.exe
node scripts/release-key.mjs verifica "$out"

# Prima i file, per ultimo il manifest: nessuna app vede la versione nuova prima che i file ci siano.
scp "$out/Ciccio-mac.zip" "$out/Ciccio-mac.dmg" "$out/Ciccio-windows-setup.exe" \
  "$out/Ciccio-mac.zip.sig" "$out/Ciccio-mac.dmg.sig" "$out/Ciccio-windows-setup.exe.sig" "$dest/"
scp "$out/app.json.sig" "$dest/"
scp "$out/app.json" "$dest/"
echo "Pubblicata la versione $version in $dest"
