#!/usr/bin/env bash
# Helper root di Ciccio: mette in /opt/ciccio-app/<nome> UN programma scaricato (AppImage o archivio tar), dopo che
# l'utente l'ha approvato in Ciccio. Installato in /usr/local/sbin/ciccio-app-install da deploy/app-helper.sh;
# l'utente di Ciccio lo lancia con sudo (sudoers limitato a questo file). Fa solo questo:
# - il file lo scarica il server di Ciccio come utente normale; qui si prende una copia di root e se ne ricontrolla
#   lo sha256 (quello che l'utente ha visto nella card): da quel momento il file dell'utente non conta più;
# - l'estrazione non esegue niente del programma: AppImage con unsquashfs (si legge l'offset dall'ELF, senza lanciare
#   l'AppImage), archivi con tar; entrambi come utente «nobody» in una cartella vuota, poi tutto passa a root, senza
#   setuid/setgid e senza scrittura per altri; file speciali (dispositivi, socket) tolti;
# - il programma va solo in /opt/ciccio-app/<nome> e i comandi solo come link in /usr/local/bin; un link non
#   sostituisce mai un comando di sistema né un file che non sia un link di Ciccio;
# - un programma già presente si sostituisce solo se l'ha messo questo helper (marcatore .ciccio-app);
# - registra chi, cosa e quando in /var/log/ciccio-app.log.
# Uso: ciccio-app-install <nome> <appimage|tar> <file> <sha256> <comandi|-> [richiesta]
#        comandi: nome=percorso,nome=percorso (percorso relativo alla cartella del programma, es. freecadcmd=usr/bin/freecadcmd)
#        richiesta: progetto e chat, solo per il registro
#      ciccio-app-install togli <nome>
# Ultima riga dell'output: «OK <nome> <n> comandi», «TOLTO <nome>» oppure «ERRORE <motivo>»; prima, righe «AVVISO …» e «ESEGUIBILI: …».
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 022
LOG=/var/log/ciccio-app.log
BASE=/opt/ciccio-app
BIN=/usr/local/bin
MAX_BYTES=$((4 * 1024 * 1024 * 1024))

if [[ "${1:-}" == togli ]]; then ACTION=togli; NAME="${2:-}"; else ACTION=installa; NAME="${1:-}"; fi
KIND="${2:-}"; FILE="${3:-}"; SHA="${4:-}"; CMDS="${5:-}"
WHO="$(printf '%s' "${6:-}" | tr -cd 'A-Za-z0-9 ._:/@()+-' | cut -c1-120)"
CLEAN="$(printf '%s' "$NAME" | tr -cd 'a-z0-9-' | cut -c1-32)"

log() { printf '%s\t%s\t%s\t%s\t%s\n' "$(date -Is)" "${SUDO_USER:-$(id -un)}" "${CLEAN:-?}" "$1" "${WHO:-—}${2:+ · $2}" >> "$LOG"; }
fail() { log rifiutato "$1"; echo "ERRORE $1"; exit 1; }

[[ $EUID -eq 0 ]] || { echo "ERRORE serve root (sudo)"; exit 1; }
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || fail "nome non valido: minuscole, cifre e trattini (2-31 caratteri)"

mkdir -p "$BASE" && chmod 755 "$BASE"
exec 9>/run/ciccio-app.lock
flock -w 600 9 || fail "un'altra installazione è in corso"

# Link di /usr/local/bin che puntano dentro questo programma.
links_of() { local l; for l in "$BIN"/*; do [[ -L "$l" ]] && [[ "$(readlink "$l")" == "$BASE/$1/"* ]] && echo "$l"; done; return 0; }

if [[ "$ACTION" == togli ]]; then
  [[ $# -eq 2 ]] || fail "uso: ciccio-app-install togli <nome>"
  [[ -f "$BASE/$NAME/.ciccio-app" ]] || fail "$NAME non è un programma installato da Ciccio"
  while read -r l; do [[ -n "$l" ]] && rm -f "$l"; done < <(links_of "$NAME")
  rm -rf "${BASE:?}/$NAME"
  log tolto
  echo "TOLTO $NAME"; exit 0
fi

[[ $# -ge 5 && $# -le 6 ]] || fail "uso: ciccio-app-install <nome> <appimage|tar> <file> <sha256> <comandi|-> [richiesta]"
[[ "$KIND" == appimage || "$KIND" == tar ]] || fail "tipo non valido: appimage o tar"
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || fail "sha256 non valido"
for c in setpriv python3 tar; do command -v "$c" >/dev/null || fail "manca $c sul server"; done
[[ "$KIND" == tar ]] || command -v unsquashfs >/dev/null || fail "manca unsquashfs: serve il pacchetto squashfs-tools (installa_programma squashfs-tools)"

# Il file: assoluto, vero (niente link né cartelle con link), dell'utente che ha lanciato sudo, in una cartella solo sua.
[[ "$FILE" == /* && "$FILE" != *..* ]] || fail "percorso del file non valido"
[[ ! -L "$FILE" && -f "$FILE" && "$(realpath -e "$FILE" 2>/dev/null)" == "$FILE" ]] || fail "il file da installare non c'è o non è un file normale"
[[ -n "${SUDO_UID:-}" && "$(stat -c %u "$FILE")" == "$SUDO_UID" && "$(stat -c %u "$(dirname "$FILE")")" == "$SUDO_UID" ]] || fail "il file deve essere dell'utente di Ciccio, in una sua cartella"
[[ "$(stat -c %a "$(dirname "$FILE")")" =~ ^[0-7]?[0-7][0145][0145]$ ]] || fail "la cartella del file non deve essere scrivibile da altri"
SIZE="$(stat -c %s "$FILE")"
(( SIZE > 0 && SIZE <= MAX_BYTES )) || fail "file vuoto o oltre 4 GB"

# Comandi da collegare, controllati prima di toccare qualcosa: nome semplice, percorso relativo, niente comandi di sistema.
declare -A LINKS=()
if [[ "$CMDS" != - && -n "$CMDS" ]]; then
  IFS=',' read -ra ENT <<<"$CMDS"
  for e in "${ENT[@]}"; do
    c="${e%%=*}"; p="${e#*=}"
    [[ "$e" == *=* && "$c" =~ ^[a-z0-9][a-z0-9._-]{0,40}$ ]] || fail "comando non valido: ${e:0:60}"
    [[ "$p" =~ ^[A-Za-z0-9._/+-]{1,200}$ && "$p" != /* && "$p" != *..* ]] || fail "percorso non valido per $c: ${p:0:60}"
    for d in /usr/bin /bin /usr/sbin /sbin /usr/local/sbin; do [[ -e "$d/$c" || -L "$d/$c" ]] && fail "$c è già un comando di sistema ($d/$c): scegli un altro nome"; done
    if [[ -e "$BIN/$c" || -L "$BIN/$c" ]]; then
      [[ -L "$BIN/$c" && "$(readlink "$BIN/$c")" == "$BASE/"* ]] || fail "$BIN/$c esiste già e non è di Ciccio"
    fi
    LINKS[$c]="$p"
  done
fi

# Posto per la copia e per l'estrazione (stesso disco di /opt, così lo spostamento finale è atomico).
WORK="$(mktemp -d "$BASE/.work.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
chmod 711 "$WORK"
avail="$(df -B1 --output=avail "$BASE" | tail -1 | tr -d ' ')"
(( avail > SIZE * 4 + 500 * 1024 * 1024 )) || fail "poco spazio su disco in $BASE (servono circa $(( (SIZE * 4 + 500 * 1024 * 1024) / 1048576 )) MB)"
cp --no-preserve=all "$FILE" "$WORK/in" || fail "non riesco a copiare il file"
chmod 644 "$WORK/in"
[[ "$(sha256sum "$WORK/in" | cut -d' ' -f1)" == "$SHA" ]] || fail "lo sha256 del file non corrisponde a quello approvato"
log avvio "$KIND · $((SIZE / 1048576)) MB"

NU="$(id -u nobody)"; NG="$(id -g nobody)"
mkdir "$WORK/out" && chown "$NU:$NG" "$WORK/out"
NOBODY=(setpriv --reuid="$NU" --regid="$NG" --clear-groups --no-new-privs --)
APP="$WORK/out/app"
if [[ "$KIND" == appimage ]]; then
  # Una AppImage di tipo 2 è un ELF seguito da un filesystem squashfs: l'offset è la fine delle intestazioni di sezione.
  off="$(python3 -I - "$WORK/in" <<'PY'
import struct, sys
f = open(sys.argv[1], 'rb'); h = f.read(64)
if len(h) < 64 or h[:4] != b'\x7fELF' or h[4] != 2 or h[5] != 1: sys.exit(1)
shoff, = struct.unpack_from('<Q', h, 0x28); shentsize, shnum = struct.unpack_from('<HH', h, 0x3A)
off = shoff + shentsize * shnum
f.seek(off)
if f.read(4) != b'hsqs': sys.exit(1)
print(off)
PY
)" || fail "non è una AppImage di tipo 2 (ELF a 64 bit con squashfs in coda)"
  out="$(timeout 900 "${NOBODY[@]}" unsquashfs -n -no-xattrs -o "$off" -d "$APP" "$WORK/in" 2>&1)" || { echo "$out" | tail -5; fail "estrazione dell'AppImage non riuscita"; }
else
  mkdir "$APP" && chown "$NU:$NG" "$APP"
  out="$(timeout 900 "${NOBODY[@]}" tar -xf "$WORK/in" -C "$APP" --no-same-owner --no-same-permissions 2>&1)" || { echo "$out" | tail -5; fail "estrazione dell'archivio non riuscita (tar.gz, tar.xz o tar.bz2)"; }
  # Un solo livello in cima (nome-1.2.3/…): il programma è quello.
  if [[ "$(find "$APP" -mindepth 1 -maxdepth 1 | wc -l)" == 1 ]]; then
    top="$(find "$APP" -mindepth 1 -maxdepth 1 -type d | head -1)"
    [[ -z "$top" ]] || APP="$top"
  fi
fi
[[ -n "$(find "$APP" -mindepth 1 -type f -print -quit 2>/dev/null)" ]] || fail "l'estrazione non ha prodotto file"

# Da qui è tutto di root: niente file speciali, niente setuid/setgid, niente scrittura per altri, tutto leggibile.
find "$APP" \( -type b -o -type c -o -type p -o -type s \) -delete 2>/dev/null
chown -hR root:root "$APP"
chmod -R u-s,g-s,go-w,a+rX "$APP"

# Il percorso di ogni comando deve restare dentro il programma e puntare a un eseguibile.
AVV=()
declare -A OKLINK=()
for c in "${!LINKS[@]}"; do
  p="${LINKS[$c]}"
  real="$(realpath -e "$APP/$p" 2>/dev/null || true)"
  if [[ -z "$real" || "$real" != "$(realpath "$APP")"/* ]]; then AVV+=("$c: $p non c'è nel programma (o esce dalla sua cartella): nessun link"); continue; fi
  if [[ ! -f "$real" || ! -x "$real" ]]; then AVV+=("$c: $p non è un eseguibile: nessun link"); continue; fi
  OKLINK[$c]="$p"
done

dest="$BASE/$NAME"
replace=0
if [[ -e "$dest" || -L "$dest" ]]; then
  [[ -f "$dest/.ciccio-app" && ! -L "$dest" ]] || fail "$dest esiste e non l'ha messo Ciccio"
  replace=1
fi
printf 'nome=%s\nsha256=%s\nquando=%s\nchi=%s\ncomandi=%s\n' "$NAME" "$SHA" "$(date -Is)" "${WHO:-—}" "${!OKLINK[*]}" > "$APP/.ciccio-app"
chmod 644 "$APP/.ciccio-app"
if (( replace )); then
  # I link vecchi di questo programma che il nuovo non rifà spariscono: non devono restare puntati a niente.
  while read -r l; do [[ -n "$l" ]] && rm -f "$l"; done < <(links_of "$NAME")
  mv -T "$dest" "$WORK/old" || fail "non riesco a sostituire la versione precedente"
fi
mv -T "$APP" "$dest" || fail "non riesco a spostare il programma in $dest"
n=0
for c in "${!OKLINK[@]}"; do ln -sfn "$dest/${OKLINK[$c]}" "$BIN/$c" && n=$((n + 1)); done
log installato "$((SIZE / 1048576)) MB · $n comandi${AVV:+ · ${AVV[*]}}"

for a in "${AVV[@]}"; do echo "AVVISO $a"; done
echo "ESEGUIBILI: $(cd "$dest" && find . -maxdepth 4 -type f -perm -u+x \( -path '*/bin/*' -o -path '*/sbin/*' -o -regex '\./[^/]*' \) -printf '%P ' 2>/dev/null | cut -c1-600)"
echo "OK $NAME $n comandi"
