#!/usr/bin/env bash
# Binari del companion (un file, senza Node installato) per Mac e Windows, con Bun.
#   bash companion/build.sh                    tutti
#   bash companion/build.sh windows-x64        solo quello
# Icona e dati del file .exe (nome, editore, versione) Bun li scrive solo compilando su Windows:
# dal Mac l'.exe funziona uguale ma ha l'icona generica. La CI "Companion Windows" lo compila su Windows.
set -euo pipefail
cd "$(dirname "$0")/.."
out=dist/companion
mkdir -p "$out"
version="$(sed -n "s/^export const VERSION = '\(.*\)';/\1/p" companion/src/config.ts)"
targets=("$@")
[[ ${#targets[@]} -eq 0 ]] && targets=(darwin-arm64 darwin-x64 windows-x64)
on_windows=false
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) on_windows=true ;; esac
for target in "${targets[@]}"; do
  ext=""; extra=()
  if [[ "$target" == windows-* ]]; then
    ext=".exe"
    if $on_windows; then
      extra=(--windows-icon=companion/assets/icon.ico --windows-title="Ciccio Companion"
        --windows-publisher="Daniele Costa" --windows-version="$version.0"
        --windows-description="Ciccio Companion: strumenti del PC per gli agenti di Ciccio"
        --windows-copyright="Daniele Costa, AGPL-3.0")
    fi
  fi
  bun build companion/src/main.ts --compile --minify --sourcemap=none \
    --target="bun-$target" ${extra[@]+"${extra[@]}"} --outfile "$out/ciccio-companion-$target$ext"
  # Bun lascia per primo il suo gruppo di icone, che punta alla 16×16: l'icona va rimessa a tutte le misure.
  [[ ${#extra[@]} -gt 0 ]] && bun companion/fix-exe-icon.ts "$out/ciccio-companion-$target$ext"
done
rm -f "$out"/*.map .*.bun-build
ls -lh "$out"
