#!/usr/bin/env bash
# Ciccio Companion.app e il .dmg da scaricare: si trascina in Applicazioni e basta.
# App della barra dei menu (Swift) + companion compilato con Bun dentro Contents/Resources.
set -euo pipefail
cd "$(dirname "$0")/../.."
out=dist/companion
app="$out/Ciccio Companion.app"
version=$(node -e "console.log(require('fs').readFileSync('companion/src/config.ts','utf8').match(/VERSION = '([^']+)'/)[1])")
rm -rf "$app" "$out/mac-stage"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

bun build companion/src/main.ts --compile --minify --sourcemap=none --target=bun-darwin-arm64 --outfile "$app/Contents/Resources/ciccio-companion"
swiftc -O -target arm64-apple-macos13 companion/mac/main.swift -o "$app/Contents/MacOS/CiccioCompanion"

# Icona: la C pixel su verde acido, disegnata in Affinity ed esportata a ogni misura (16-1024 px).
iconutil -c icns companion/mac/AppIcon.iconset -o "$app/Contents/Resources/AppIcon.icns"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Ciccio Companion</string>
  <key>CFBundleDisplayName</key><string>Ciccio Companion</string>
  <key>CFBundleIdentifier</key><string>it.costa.ciccio-companion.app</string>
  <key>CFBundleExecutable</key><string>CiccioCompanion</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>Abbinamento a Ciccio</string>
    <key>CFBundleURLSchemes</key><array><string>ciccio-companion</string></array>
  </dict></array>
</dict>
</plist>
PLIST

# Firma locale (senza certificato Apple): necessaria per far partire l'app su Apple Silicon.
codesign --force -s - "$app/Contents/Resources/ciccio-companion"
codesign --force -s - "$app"

stage="$out/mac-stage"
mkdir -p "$stage"
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applicazioni"
rm -f "$out/CiccioCompanion-mac.dmg"
hdiutil create -quiet -volname "Ciccio Companion" -srcfolder "$stage" -ov -format UDZO "$out/CiccioCompanion-mac.dmg"
rm -rf "$stage"
ls -lh "$out/CiccioCompanion-mac.dmg"
