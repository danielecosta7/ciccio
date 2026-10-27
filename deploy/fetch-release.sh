#!/usr/bin/env bash
# Companion e app desktop da una release firmata su GitHub: scarica i file, controlla le firme Ed25519 con la
# chiave pubblica di questo codice (shared/release-key.ts) e li mette in ~/.ciccio/downloads (CICCIO_DATA_DIR).
# Da lì Ciccio li offre ai PC collegati (Impostazioni › Companion e › App, aggiornamento automatico), che
# ricontrollano le firme prima di installare.
#
# Da eseguire come l'utente di Ciccio, dentro ~/ciccio (lo lancia anche install.sh, vedi CICCIO_FETCH_RELEASE).
# Passa dal proxy di uscita: github.com, api.github.com e i file delle release (release-assets.githubusercontent.com,
# objects.githubusercontent.com) sono nell'elenco di deploy/egress-firewall.sh.
#
# Uso: bash deploy/fetch-release.sh              l'ultima release
#      bash deploy/fetch-release.sh 0.2.0        la release v0.2.0
#      CICCIO_RELEASE_REPO=utente/ciccio         un'altra repo (di base quella di origin di questo clone)
#      FORCE=1                                   anche se è più vecchia di quella già in downloads
# Esce con 1 se qualcosa non va (rete, file mancanti, firme): in downloads resta quello che c'era.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
ENV_FILE="$HOME/.config/ciccio.env"
# Variabili del servizio, proxy di uscita compreso.
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi
DEST="${CICCIO_DATA_DIR:-$HOME/.ciccio}/downloads"
die() { echo "fetch-release: $*" >&2; exit 1; }

command -v node >/dev/null || die "manca Node (~/.local/node)."
command -v curl >/dev/null || die "manca curl."
# Con il segnaposto al posto della chiave pubblica non c'è niente con cui controllare: meglio fermarsi.
node scripts/release-key.mjs chiavi-del-repo >/dev/null || die "nessuna chiave pubblica in shared/release-key.ts: non scarico release che non potrei controllare."

repo="${CICCIO_RELEASE_REPO:-}"
if [[ -z "$repo" ]]; then
  url="$(git remote get-url origin 2>/dev/null || true)"
  [[ "$url" =~ github\.com[:/]([^/]+/[^/]+)$ ]] && repo="${BASH_REMATCH[1]%.git}"
fi
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "non so da quale repo di GitHub scaricare: CICCIO_RELEASE_REPO=utente/ciccio"

curl_get() { curl -fsSL --proto '=https' --retry 2 --connect-timeout 15 --max-time "${2:-600}" "$1"; }
if [[ -n "${1:-}" ]]; then
  tag="v${1#v}"
else
  tag="$(curl_get "https://api.github.com/repos/$repo/releases/latest" 60 | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { process.stdout.write(String(JSON.parse(s).tag_name ?? "")); } catch { process.exit(1); }
    });')" || die "non riesco a chiedere a GitHub l'ultima release di $repo (rete, proxy o nessuna release)."
fi
[[ "$tag" =~ ^v[0-9A-Za-z.+-]+$ ]] || die "release non valida: «$tag»"

mkdir -p "$DEST"
# Cartella di lavoro dentro downloads: stesso disco, così alla fine basta rinominare (atomico, file per file).
tmp="$(mktemp -d "$DEST/.release.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/$repo/releases/download/$tag"
get() { curl_get "$base/$1" > "$tmp/$1" || die "non riesco a scaricare $1 da $repo $tag."; }

echo "Release $tag di $repo: scarico i manifest…"
for f in companion.json companion.json.sig app.json app.json.sig; do get "$f"; done
# I file elencati nei manifest (aggiornamento e prima installazione), con le loro firme. I nomi si controllano
# qui prima di scaricare; tutto il resto lo controlla la verifica qui sotto.
files="$(node -e '
  const fs = require("fs"); const path = require("path"); const names = new Set();
  for (const m of ["companion.json", "app.json"]) {
    const j = JSON.parse(fs.readFileSync(path.join(process.argv[1], m), "utf8"));
    for (const e of [...Object.values(j.files ?? {}), ...Object.values(j.installers ?? {})]) {
      if (!/^[\w.-]+$/.test(String(e?.file))) { console.error(`nome di file non valido in ${m}`); process.exit(1); }
      names.add(e.file);
    }
  }
  console.log([...names].join("\n"));' "$tmp")" || die "manifest non leggibili."
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  echo "  $f"
  get "$f"; get "$f.sig"
done <<< "$files"

node scripts/release-key.mjs verifica "$tmp" || die "firme non valide: non installo niente (in $DEST resta quello che c'era)."

# Dentro downloads, prodotto per prodotto: prima i file e le firme, poi la firma del manifest, per ultimo il
# manifest (Ciccio lo guarda per offrire la versione nuova). Una versione più vecchia di quella che c'è si salta.
node - "$tmp" "$DEST" "${FORCE:-}" <<'JS'
const fs = require('fs'); const path = require('path');
const [tmp, dest, force] = process.argv.slice(2);
const newer = (a, b) => {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0), pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};
const move = (name) => { fs.chmodSync(path.join(tmp, name), 0o644); fs.renameSync(path.join(tmp, name), path.join(dest, name)); };
for (const [product, name] of [['companion', 'companion.json'], ['app desktop', 'app.json']]) {
  const m = JSON.parse(fs.readFileSync(path.join(tmp, name), 'utf8'));
  let old = null;
  try { old = JSON.parse(fs.readFileSync(path.join(dest, name), 'utf8')).version ?? null; } catch { /* prima volta */ }
  if (old && newer(old, m.version) && !force) { console.log(`${product}: in downloads c'è già la ${old}, più nuova della ${m.version}: la lascio (FORCE=1 per installarla lo stesso)`); continue; }
  const files = new Set([...Object.values(m.files), ...Object.values(m.installers ?? {})].map((e) => e.file));
  for (const f of files) { move(f); move(`${f}.sig`); }
  move(`${name}.sig`);
  move(name);
  console.log(`${product}: versione ${m.version} in ${dest}${old && old !== m.version ? ` (prima ${old})` : ''}`);
}
JS
echo "Fatto: i PC collegati ricevono l'aggiornamento entro pochi secondi (o al prossimo collegamento)."
