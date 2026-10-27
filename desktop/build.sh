#!/usr/bin/env bash
# App desktop «Ciccio» (Tauri 2) in dist/desktop:
#   sul Mac      Ciccio.app, Ciccio-mac.dmg (prima installazione), Ciccio-mac.zip (aggiornamento automatico)
#   su Windows   Ciccio-windows-setup.exe (installer per l'utente, senza amministratore; anche aggiornamento)
# Serve Rust (rustup) e Node: la CLI di Tauri si prende con npx alla versione fissata qui.
# La versione è quella di desktop/src-tauri/Cargo.toml.
set -euo pipefail
cd "$(dirname "$0")/.."
cli=@tauri-apps/cli@2.12.4
out=dist/desktop
bundle=desktop/src-tauri/target/release/bundle
mkdir -p "$out"
version=$(sed -n 's/^version = "\(.*\)"/\1/p' desktop/src-tauri/Cargo.toml | head -1)
echo "Ciccio $version"

case "$(uname -s)" in
  Darwin)
    (cd desktop && npx --yes "$cli" build --bundles app)
    rm -rf "$out/Ciccio.app"
    cp -R "$bundle/macos/Ciccio.app" "$out/"
    # Firma locale (senza certificato Apple), come il companion: basta per farla partire su Apple Silicon.
    codesign --force --deep -s - "$out/Ciccio.app"
    # .dmg con hdiutil (lo script di Tauri usa il Finder via AppleScript, che in CI non c'è).
    stage="$out/mac-stage"
    rm -rf "$stage" && mkdir -p "$stage"
    cp -R "$out/Ciccio.app" "$stage/"
    ln -s /Applications "$stage/Applicazioni"
    rm -f "$out/Ciccio-mac.dmg"
    hdiutil create -quiet -volname "Ciccio" -srcfolder "$stage" -ov -format UDZO "$out/Ciccio-mac.dmg"
    rm -rf "$stage"
    rm -f "$out/Ciccio-mac.zip"
    ditto -c -k --keepParent "$out/Ciccio.app" "$out/Ciccio-mac.zip"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    (cd desktop && npx --yes "$cli" build --bundles nsis)
    cp "$bundle/nsis/Ciccio_${version}_x64-setup.exe" "$out/Ciccio-windows-setup.exe"
    ;;
  *)
    echo "Si compila sul Mac (app del Mac) o su Windows (installer)." >&2
    exit 1
    ;;
esac
ls -lh "$out"
