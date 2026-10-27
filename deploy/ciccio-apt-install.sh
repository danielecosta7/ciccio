#!/usr/bin/env bash
# Helper root di Ciccio: installa UN pacchetto ufficiale di Ubuntu, dopo che l'utente l'ha approvato in Ciccio.
# Installato in /usr/local/sbin/ciccio-apt-install da deploy/apt-helper.sh; l'utente di Ciccio lo lancia con
# sudo (sudoers limitato a questo file). Fa solo questo:
# - il nome deve essere un nome di pacchetto semplice: niente versioni, file .deb, URL, PPA o opzioni;
# - usa solo le sorgenti ufficiali di Ubuntu (ubuntu.sources), nella simulazione come nell'installazione: gli altri
#   repository configurati (Docker, Tailscale…) per queste chiamate non esistono; in più ogni pacchetto, dipendenze
#   comprese, deve avere origine Ubuntu;
# - installa esattamente i pacchetti e le versioni della simulazione (pacchetto=versione), con --no-remove: se
#   l'installazione toglierebbe qualcosa, si ferma; un pacchetto già installato non si aggiorna;
# - registra chi, cosa e quando in /var/log/ciccio-apt.log.
# Uso: ciccio-apt-install <pacchetto> [richiesta]   (richiesta: progetto e chat, solo per il registro)
# Ultima riga dell'output: «OK <pacchetto> <versione>», «GIA <pacchetto> <versione>» oppure «ERRORE <motivo>».
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C DEBIAN_FRONTEND=noninteractive
# Nessun servizio riavviato da needrestart a metà installazione.
export NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l
umask 022
LOG=/var/log/ciccio-apt.log

PKG="${1:-}"
WHO="$(printf '%s' "${2:-}" | tr -cd 'A-Za-z0-9 ._:/@()+-' | cut -c1-120)"
CLEAN="$(printf '%s' "$PKG" | tr -cd 'a-z0-9.+-' | cut -c1-64)"

log() { printf '%s\t%s\t%s\t%s\t%s\n' "$(date -Is)" "${SUDO_USER:-$(id -un)}" "${CLEAN:-?}" "$1" "${WHO:-—}${2:+ · $2}" >> "$LOG"; }
fail() { log rifiutato "$1"; echo "ERRORE $1"; exit 1; }

[[ $EUID -eq 0 ]] || { echo "ERRORE serve root (sudo)"; exit 1; }
[[ $# -ge 1 && $# -le 2 ]] || fail "uso: ciccio-apt-install <pacchetto> [richiesta]"
[[ "$PKG" =~ ^[a-z0-9][a-z0-9.+-]{1,62}$ ]] || fail "nome non valido: solo il nome del pacchetto (a-z, 0-9, . + -), senza versioni, file, URL o opzioni"

# Una installazione alla volta.
exec 9>/run/ciccio-apt.lock
flock -w 600 9 || fail "un'altra installazione è in corso"

if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$PKG" 2>/dev/null)" == installed ]]; then
  ver="$(dpkg-query -W -f='${Version}' "$PKG")"
  log gia "$ver"
  echo "GIA $PKG $ver"
  exit 0
fi

# Solo le sorgenti di Ubuntu: una copia in una cartella a parte, al posto di sources.list e sources.list.d. Gli elenchi
# già scaricati restano quelli di sempre; la cache dei pacchetti si rifà in memoria, senza toccare quella di sistema.
SRC="$(mktemp -d)"; trap 'rm -rf "$SRC"' EXIT
mkdir "$SRC/parts"; : > "$SRC/none.list"
if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then cp /etc/apt/sources.list.d/ubuntu.sources "$SRC/parts/"
elif grep -qE '^deb .*(archive|security|ports)\.ubuntu\.com' /etc/apt/sources.list 2>/dev/null; then cp /etc/apt/sources.list "$SRC/parts/ubuntu.list"
else fail "non trovo le sorgenti ufficiali di Ubuntu (/etc/apt/sources.list.d/ubuntu.sources)"; fi
ONLY_UBUNTU=(-o "Dir::Etc::SourceList=$SRC/none.list" -o "Dir::Etc::SourceParts=$SRC/parts" -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache=)

# Prima la simulazione: cosa entrerebbe, da dove, e se toglierebbe qualcosa.
plan="$(apt-get -s -q "${ONLY_UBUNTU[@]}" install --no-install-recommends --no-remove "$PKG" 2>&1)" || fail "$(grep -E '^E:' <<<"$plan" | head -1 | cut -c1-200)"
grep -q '^Note, selecting' <<<"$plan" && fail "$PKG non è il nome esatto di un pacchetto ($(grep -m1 '^Note, selecting' <<<"$plan" | cut -c1-160))"
grep -q '^Remv ' <<<"$plan" && fail "l'installazione toglierebbe pacchetti: $(grep '^Remv ' <<<"$plan" | awk '{print $2}' | tr '\n' ' ')"
grep -q "^Inst $PKG " <<<"$plan" || fail "$PKG non risulta da installare"
other="$(grep '^Inst ' <<<"$plan" | grep -Ev '\([^ ]+ Ubuntu:[0-9.]+/[a-z-]+(, Ubuntu:[0-9.]+/[a-z-]+)* \[[a-z0-9]+\]\)$' | awk '{print $2}' | tr '\n' ' ')"
[[ -z "$other" ]] || fail "non vengono dai repository ufficiali di Ubuntu: $other"
# L'elenco esatto della simulazione, pacchetto=versione: l'installazione non può scegliere altro.
mapfile -t WANT < <(sed -nE 's/^Inst ([^ ]+) (\[[^]]*\] )?\(([^ ]+) .*/\1=\3/p' <<<"$plan")
(( ${#WANT[@]} == $(grep -c '^Inst ' <<<"$plan") )) || fail "non riesco a leggere la simulazione di apt"
for w in "${WANT[@]}"; do [[ "$w" =~ ^[a-z0-9][a-z0-9.+:-]*=[A-Za-z0-9.+~:-]+$ ]] || fail "voce inattesa nella simulazione: ${w:0:80}"; done
deps=$(( ${#WANT[@]} - 1 ))
# Le dipendenze nuove (o già automatiche) restano «automatiche» anche se si nominano una per una.
prev_auto="$(apt-mark showauto 2>/dev/null)"
auto=()
for w in "${WANT[@]}"; do
  n="${w%%=*}"; [[ "$n" == "$PKG" ]] && continue
  if [[ "$(dpkg-query -W -f='${db:Status-Status}' "$n" 2>/dev/null)" != installed ]] || grep -qxF "$n" <<<"$prev_auto"; then auto+=("$n"); fi
done

log avvio "$deps dipendenze"
out="$(timeout 900 apt-get install -y -q --no-install-recommends --no-remove "${ONLY_UBUNTU[@]}" \
  -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "${WANT[@]}" 2>&1)"
code=$?
if [[ $code -ne 0 ]]; then
  msg="$(grep -E '^E:' <<<"$out" | tail -1 | cut -c1-200)"
  log errore "uscita $code${msg:+ · $msg}"
  echo "$out" | tail -15
  echo "ERRORE apt-get è uscito con $code${msg:+: $msg}"
  exit 1
fi
(( ${#auto[@]} == 0 )) || apt-mark auto "${auto[@]}" >/dev/null 2>&1 || true
ver="$(dpkg-query -W -f='${Version}' "$PKG")"
log installato "$ver · $deps dipendenze"
echo "OK $PKG $ver"
