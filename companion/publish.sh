#!/usr/bin/env bash
# Pubblica a mano una versione del companion su un server, senza passare da una release di GitHub
# (il modo normale è la release firmata: tag vX.Y.Z, poi deploy/fetch-release.sh sul server).
# I PC collegati la scaricano e si aggiornano da soli solo se è firmata con la chiave delle release.
#   1. alza VERSION in companion/src/config.ts
#   2. bash companion/publish.sh            (sul Mac: compila Mac e Windows, scrive e firma companion.json, copia sul server)
#      DEST=utente@server:.ciccio/downloads    cartella di destinazione sul server (obbligatoria)
#      CICCIO_RELEASE_KEY_FILE=<file>          chiave privata delle release (PEM, obbligatoria: senza non si pubblica)
#      SKIP_BUILD=1                         usa i file già compilati in dist/companion
# Il .exe compilato dal Mac ha l'icona generica: per quello con icona usa l'artefatto della CI Windows
# (copialo in dist/companion/ciccio-companion-windows-x64.exe e lancia con SKIP_BUILD=1).
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist/companion
dest="${DEST:?Imposta DEST, es. DEST=ciccio@server:.ciccio/downloads}"
[[ -n "${CICCIO_RELEASE_KEY_FILE:-}${CICCIO_RELEASE_KEY:-}" ]] || { echo "Manca CICCIO_RELEASE_KEY_FILE (la chiave privata delle release): senza firma i companion rifiutano l'aggiornamento." >&2; exit 1; }
version="$(sed -n "s/^export const VERSION = '\(.*\)';/\1/p" companion/src/config.ts)"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  bash companion/mac/build-app.sh
  bash companion/build.sh windows-x64
fi

# Per l'aggiornamento del Mac serve l'app zippata (il .dmg resta per la prima installazione).
rm -f "$out/CiccioCompanion-mac.zip"
ditto -c -k --keepParent "$out/Ciccio Companion.app" "$out/CiccioCompanion-mac.zip"
cp "$out/ciccio-companion-windows-x64.exe" "$out/CiccioCompanion-windows.exe"

# Manifest con sha256 e firma di ogni file, la sua firma e le firme separate (<file>.sig): come la release.
node scripts/release-key.mjs manifest companion "$version" "$out" \
  darwin-arm64=CiccioCompanion-mac.zip win32-x64=CiccioCompanion-windows.exe \
  --installer darwin-arm64=CiccioCompanion-mac.dmg --installer win32-x64=CiccioCompanion-windows.exe
node scripts/release-key.mjs verifica "$out"

# Prima i file, per ultimo il manifest: nessun PC vede la versione nuova prima che i file ci siano.
scp "$out/CiccioCompanion-mac.zip" "$out/CiccioCompanion-mac.dmg" "$out/CiccioCompanion-windows.exe" \
  "$out/CiccioCompanion-mac.zip.sig" "$out/CiccioCompanion-mac.dmg.sig" "$out/CiccioCompanion-windows.exe.sig" "$dest/"
scp "$out/companion.json.sig" "$dest/"
scp "$out/companion.json" "$dest/"
echo "Pubblicata la versione $version in $dest"
