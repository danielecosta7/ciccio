#!/usr/bin/env bash
# Installazione guidata di Ciccio su un server Ubuntu 24.04 vuoto. Si lancia come root, da un clone del repo.
# Ogni passo: controlla com'è il server, spiega in una riga, chiede (con una risposta di default), fa e verifica.
# Si può rilanciare quante volte si vuole: i passi già a posto si saltano.
#
# Uso (come root):
#   sudo bash deploy/setup.sh               tutti i passi, in ordine
#   sudo bash deploy/setup.sh --yes         risponde a ogni domanda con il default (niente domande)
#   sudo bash deploy/setup.sh --check       solo la tabella dello stato, senza cambiare niente
#   sudo bash deploy/setup.sh --step NOME   un passo solo (anche se risulta già a posto)
#   sudo bash deploy/setup.sh --user NOME   utente di Ciccio (default: quello in /etc/ciccio/user, poi «ciccio»)
# Passi, in ordine: sistema utente pacchetti node tailscale linger repo copia-root ciccio firewall helper
#                   schermo voce dominio fine
# Dopo la prima volta setup.sh sta anche in /usr/local/lib/ciccio (copia di root, che l'utente di Ciccio non può
# modificare): da lì si rilancia, per esempio per aggiornare gli script di root con --step copia-root.
set -euo pipefail

PUBLIC_REPO=https://github.com/danielecosta7/ciccio
LIB=/usr/local/lib/ciccio
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SELF")"
STEPS=(sistema utente pacchetti node tailscale linger repo copia-root ciccio firewall helper schermo voce dominio fine)
# Script che root esegue: vanno nella copia di root, mai eseguiti dalla cartella dell'utente.
ROOT_FILES=(setup.sh egress-firewall.sh egress-helper.sh ciccio-egress-allow.sh apt-helper.sh ciccio-apt-install.sh
  ssh-helper.sh ciccio-ssh-allow.sh ssh-hosts.sh)
PKGS=(git gh bubblewrap socat curl ca-certificates xz-utils build-essential python3 python3-venv ufw)

declare -A DESC=(
  [sistema]="il server: Ubuntu 24.04, architettura"
  [utente]="l'utente senza sudo che esegue Ciccio e gli agenti"
  [pacchetti]="programmi di sistema e sandbox degli agenti (bubblewrap, AppArmor)"
  [node]="Node 24 dell'utente, da nodejs.org"
  [tailscale]="Ciccio dalla tua tailnet, in https"
  [linger]="servizi dell'utente accesi anche senza sessione aperta"
  [repo]="il codice di Ciccio in ~utente/ciccio"
  [copia-root]="copia di root degli script che root esegue ($LIB)"
  [ciccio]="configurazione, GitHub, compilazione, avvio e login di claude.ai"
  [firewall]="firewall in uscita: gli agenti escono solo verso i domini consentiti"
  [helper]="domini, programmi e server SSH nuovi su richiesta, con la tua approvazione"
  [schermo]="schermo virtuale per i programmi grafici degli agenti (facoltativo)"
  [voce]="voce sul server, Whisper e Piper in locale (facoltativo)"
  [dominio]="un dominio pubblico oltre alla tailnet (facoltativo)"
  [fine]="codice di attivazione e prossimi passi"
)

YES=""; CHECK=""; ONLY=""; U=""
while (( $# )); do
  case "$1" in
    -y|--yes) YES=1 ;;
    --check) CHECK=1 ;;
    --step) ONLY="${2:-}"; shift ;;
    --step=*) ONLY="${1#*=}" ;;
    --user) U="${2:-}"; shift ;;
    --user=*) U="${1#*=}" ;;
    -h|--help) sed -n '2,/^set -euo/p' "$SELF" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opzione sconosciuta: $1 (vedi --help)" >&2; exit 1 ;;
  esac
  shift
done

# --- Uscita e domande ----------------------------------------------------------------------------------------------
if [[ -t 1 ]]; then BOLD=$'\e[1m'; GRN=$'\e[32m'; YEL=$'\e[33m'; RED=$'\e[31m'; DIM=$'\e[2m'; OFF=$'\e[0m'
else BOLD=""; GRN=""; YEL=""; RED=""; DIM=""; OFF=""; fi
title() { printf '\n%s== %s%s\n' "$BOLD" "$*" "$OFF"; }
info()  { printf '   %s\n' "$*"; }
ok()    { printf '   %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn()  { printf '   %s!%s %s\n' "$YEL" "$OFF" "$*" >&2; }
die()   { printf '   %s✗ %s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }
indent() { sed 's/^/   │ /'; }

[[ -z "$ONLY" ]] || printf '%s\n' "${STEPS[@]}" | grep -qxF -- "$ONLY" || die "passo sconosciuto: $ONLY (passi: ${STEPS[*]})"
[[ $EUID -eq 0 ]] || { echo "Da eseguire come root: sudo bash $0" >&2; exit 1; }

# ask "domanda" [s|n]: 0 = sì. Con --yes vale il default.
ask() {
  local def="${2:-s}" hint="S/n" a
  [[ "$def" == n ]] && hint="s/N"
  if [[ -n "$YES" ]]; then printf '   %s [%s] %s(--yes: %s)%s\n' "$1" "$hint" "$DIM" "$def" "$OFF"; [[ "$def" == s ]]; return; fi
  [[ -t 0 ]] || die "serve un terminale per rispondere (oppure --yes)"
  while true; do
    read -r -p "   $1 [$hint] " a || a=""
    a="${a:-$def}"; a="${a,,}"
    case "$a" in s|si|sì|y|yes) return 0 ;; n|no) return 1 ;; esac
  done
}
# prompt "domanda" default: stampa la risposta (con --yes, il default).
prompt() {
  local a
  if [[ -n "$YES" ]]; then printf '   %s: %s %s(--yes)%s\n' "$1" "$2" "$DIM" "$OFF" >&2; printf '%s' "$2"; return; fi
  [[ -t 0 ]] || die "serve un terminale per rispondere (oppure --yes)"
  read -r -p "   $1${2:+ [$2]}: " a || a=""
  printf '%s' "${a:-$2}"
}
# secret "domanda": come prompt, senza mostrare quello che si scrive.
secret() {
  local a
  [[ -t 0 ]] || die "serve un terminale per rispondere"
  read -r -s -p "   $1: " a || a=""
  echo >&2
  printf '%s' "$a"
}

# --- Utente di Ciccio --------------------------------------------------------------------------------------------
UIDN=""; HOME_U=""; REPO_U=""; PORT=8787
load_user() {
  [[ -n "$U" ]] || U="$(head -1 /etc/ciccio/user 2>/dev/null || true)"
  UIDN=""; HOME_U=""; REPO_U=""
  if [[ -n "$U" ]] && id -u "$U" >/dev/null 2>&1; then
    UIDN="$(id -u "$U")"; HOME_U="$(getent passwd "$U" | cut -d: -f6)"; REPO_U="$HOME_U/ciccio"
    local p; p="$(user_env CICCIO_PORT)"; [[ "$p" =~ ^[0-9]+$ ]] && PORT="$p"
  fi
  return 0
}
need_user() { [[ -n "$UIDN" ]] || die "manca l'utente di Ciccio: prima il passo «utente» (sudo bash $0 --step utente)"; }
# Comandi come l'utente: root non scrive mai nella sua home (un link simbolico lì non deve far scrivere root altrove).
as_user() { (cd / && runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$UIDN" "$@"); }
# Shell di login dell'utente: carica ~/.profile, proxy di uscita compreso se il firewall è già attivo.
as_login() { (cd / && runuser -l "$U" -c "export XDG_RUNTIME_DIR=/run/user/$UIDN; $1"); }
# Valore di una variabile in ~/.config/ciccio.env (vuoto se manca).
user_env() {
  [[ -n "$UIDN" ]] || return 0
  as_user awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { gsub(/^"|"$/, "", v); print v }' \
    "$HOME_U/.config/ciccio.env" 2>/dev/null || true
}
# set_env NOME, valore da stdin (così una chiave non finisce nella riga di comando, visibile a tutti con ps).
# Sostituisce la riga NOME= o «# NOME=» del modello commentato, altrimenti la aggiunge in fondo.
SET_ENV_AWK='BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
  !done && (index($0, k "=") == 1 || $0 ~ ("^# ?" k "=")) { print k "=" v; done = 1; next }
  { print }
  END { if (!done) print k "=" v }'
set_env() {
  as_user bash -c '
    set -e; f="$HOME/.config/ciccio.env"; IFS= read -r v || true
    # Spazi, apostrofi e simili tra virgolette doppie (valide sia per systemd sia per bash).
    [[ "$v" =~ ^[A-Za-z0-9_./:,@+=-]*$ ]] || v="\"$v\""
    K="$1" V="$v" awk "$2" "$f" > "$f.tmp"
    chmod 600 "$f.tmp"; mv "$f.tmp" "$f"' _ "$1" "$SET_ENV_AWK"
}
can_sudo() {
  [[ "$(id -u "$1")" == 0 ]] && return 0
  id -nG "$1" | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel|root' && return 0
  # Le sole regole di Ciccio (gli helper) non contano.
  sudo -n -l -U "$1" 2>/dev/null | grep -E '^[[:space:]]+\(' \
    | grep -vE 'NOPASSWD: /usr/local/sbin/ciccio-(egress-allow|apt-install|ssh-allow)$' | grep -q .
}
restart_ciccio() { as_user systemctl --user try-restart ciccio.service >/dev/null 2>&1 || true; }

# --- Tailscale -----------------------------------------------------------------------------------------------------
ts_json() { tailscale status --json 2>/dev/null | python3 -c "import json,sys
d=json.load(sys.stdin)
$1" 2>/dev/null || true; }
ts_state() { ts_json 'print(d.get("BackendState",""))'; }
ts_name()  { ts_json 'print((d.get("Self") or {}).get("DNSName","").rstrip("."))'; }
ts_certs() { ts_json 'print(" ".join(d.get("CertDomains") or []))'; }
serve_ok() { tailscale serve status --json 2>/dev/null | grep -q "127.0.0.1:$PORT"; }

# =====================================================================================================================
# Passi: check_<passo> stampa lo stato in una riga ed esce con 0 (a posto), 1 (da fare) o 2 (facoltativo, spento);
# do_<passo> fa il lavoro e verifica.
# =====================================================================================================================

# --- 1. sistema ----------------------------------------------------------------------------------------------------
check_sistema() {
  local id="" ver="" pretty="?"
  if [[ -r /etc/os-release ]]; then id="$(. /etc/os-release; echo "${ID:-}")"; ver="$(. /etc/os-release; echo "${VERSION_ID:-}")"; pretty="$(. /etc/os-release; echo "${PRETTY_NAME:-?}")"; fi
  local arch mem; arch="$(uname -m)"; mem=$(( $(awk '/^MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
  local d="$pretty, $arch, $(nproc) CPU, $mem MB di RAM"
  if [[ "$id" == ubuntu && "$ver" == 24.04 && ( "$arch" == x86_64 || "$arch" == aarch64 ) && -d /run/systemd/system ]]; then
    (( mem >= 3500 )) || { echo "$d (consigliati almeno 4 GB di RAM)"; return 0; }
    echo "$d"; return 0
  fi
  echo "$d (provato su Ubuntu 24.04, x86_64 o aarch64)"; return 1
}
do_sistema() {
  [[ -d /run/systemd/system ]] || die "serve systemd (servizi dell'utente): questo sistema non lo usa"
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "architettura $(uname -m) non supportata (Node 24 ufficiale: x86_64, aarch64)" ;; esac
  warn "Non è Ubuntu 24.04: i passi sono scritti per quello (apt, AppArmor, utenti) e qualcosa può non andare."
  ask "Continuo lo stesso?" n || exit 1
}

# --- 2. utente -----------------------------------------------------------------------------------------------------
check_utente() {
  [[ -n "$UIDN" ]] || { echo "da creare (default: ${U:-ciccio})"; return 1; }
  if can_sudo "$U"; then echo "$U può usare sudo: non va bene per Ciccio"; return 1; fi
  [[ "$(head -1 /etc/ciccio/user 2>/dev/null)" == "$U" ]] || { echo "$U esiste, da registrare in /etc/ciccio/user"; return 1; }
  echo "$U (uid $UIDN, home $HOME_U)"
}
do_utente() {
  info "Ciccio e gli agenti girano come un utente normale, senza sudo: un agente non deve poter diventare root."
  local name="${U:-ciccio}"
  if [[ -z "$UIDN" ]]; then name="$(prompt "Nome dell'utente di Ciccio" "$name")"; fi
  [[ "$name" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "nome utente non valido: lettere minuscole, cifre, - e _"
  if id -u "$name" >/dev/null 2>&1; then
    (( $(id -u "$name") >= 1000 )) || die "$name è un utente di sistema (uid < 1000): scegline un altro con --user"
    if can_sudo "$name"; then
      die "$name può usare sudo. Ciccio fa eseguire comandi agli agenti: togli sudo (deluser $name sudo) o scegli un altro utente con --user."
    fi
    ask "Uso l'utente esistente $name?" s || exit 1
  else
    ask "Creo l'utente $name (senza password né sudo; ci entri con sudo -iu $name)?" s || exit 1
    adduser --disabled-password --comment "" "$name" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$name" >/dev/null
  fi
  mkdir -p /etc/ciccio && chmod 755 /etc/ciccio
  echo "$name" > /etc/ciccio/user && chmod 644 /etc/ciccio/user
  U="$name"; load_user
  chmod o-rwx "$HOME_U"
  can_sudo "$U" && die "$U risulta ancora con sudo"
  ok "utente $U (uid $UIDN), registrato in /etc/ciccio/user"
}

# --- 3. pacchetti --------------------------------------------------------------------------------------------------
missing_pkgs() { local p; for p in "${PKGS[@]}"; do [[ "$(dpkg-query -W -f='${db:Status-Status}' "$p" 2>/dev/null)" == installed ]] || echo "$p"; done; }
aa_needed() { [[ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)" == 1 ]]; }
# Profilo di https://code.claude.com/docs/en/sandboxing: vale solo per bwrap, non per i comandi che lancia.
BWRAP_PROFILE='abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}'
aa_ok() { ! aa_needed || [[ -f /etc/apparmor.d/bwrap && "$(cat /etc/apparmor.d/bwrap)" == "$BWRAP_PROFILE" ]]; }
check_pacchetti() {
  local m; m="$(missing_pkgs | tr '\n' ' ')"; m="${m% }"
  [[ -z "$m" ]] || { echo "mancano: $m"; return 1; }
  aa_ok || { echo "manca il profilo AppArmor per bubblewrap (/etc/apparmor.d/bwrap)"; return 1; }
  if [[ -n "$UIDN" ]] && ! as_user bwrap --ro-bind / / true >/dev/null 2>&1; then echo "bubblewrap non parte come $U"; return 1; fi
  echo "tutti presenti${UIDN:+, bubblewrap funziona come $U}"
}
do_pacchetti() {
  local m; mapfile -t m < <(missing_pkgs)
  if (( ${#m[@]} )); then
    info "git e gh per repo e PR, bubblewrap e socat per la sandbox degli agenti, build-essential se un modulo nativo"
    info "va compilato, python3-venv per la voce, ufw per il firewall, curl e xz-utils per gli scaricamenti."
    ask "Installo con apt: ${m[*]}?" s || die "servono per continuare"
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${m[@]}"
  fi
  if ! aa_ok; then
    info "Ubuntu 24.04 vieta a bubblewrap i namespace utente: serve il profilo AppArmor /etc/apparmor.d/bwrap (userns),"
    info "come da https://code.claude.com/docs/en/sandboxing. Vale solo per bwrap, non per i comandi che lancia."
    ask "Scrivo il profilo e ricarico AppArmor?" s || die "senza, la sandbox degli agenti non parte"
    printf '%s\n' "$BWRAP_PROFILE" > /etc/apparmor.d/bwrap
    chmod 644 /etc/apparmor.d/bwrap
    systemctl reload apparmor
  fi
  socat -V >/dev/null 2>&1 || die "socat non funziona"
  need_user
  as_user bwrap --ro-bind / / true || die "bubblewrap non parte come $U (vedi l'errore qui sopra): la sandbox degli agenti non funzionerebbe"
  ok "pacchetti presenti, bubblewrap e socat funzionano come $U"
}

# --- 4. node -------------------------------------------------------------------------------------------------------
check_node() {
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  local v major
  v="$(as_user "$HOME_U/.local/node/bin/node" -v 2>/dev/null)" || { echo "Node non installato in ~$U/.local/node"; return 1; }
  major="${v#v}"; major="${major%%.*}"
  (( major >= 24 )) || { echo "c'è Node $v, serve il 24"; return 1; }
  as_user test -x "$HOME_U/.local/node/bin/corepack" || { echo "Node $v senza corepack"; return 1; }
  echo "Node $v in ~$U/.local/node, con corepack"
}
do_node() {
  need_user
  local arch
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) die "architettura $(uname -m) senza Node ufficiale" ;; esac
  info "Node 24 per $U in ~/.local/node, separato da quello di sistema: l'ultimo 24.x da nodejs.org, controllato con SHASUMS256.txt."
  ask "Scarico e installo Node 24?" s || die "Ciccio gira su Node 24"
  local base=https://nodejs.org/dist/latest-v24.x tmp file
  tmp="$(mktemp -d)"; chmod 755 "$tmp"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(awk -v a="linux-$arch.tar.xz" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-" a "$") { print $2 }' "$tmp/SHASUMS256.txt" | head -1)"
  [[ -n "$file" ]] || die "non trovo Node 24 per linux-$arch in $base/SHASUMS256.txt"
  info "scarico $file"
  curl -fL --progress-bar "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep -E "  $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "l'impronta di $file non corrisponde a SHASUMS256.txt: non lo installo"
  ok "impronta sha256 controllata"
  chmod 644 "$tmp/$file"
  # Lo estrae l'utente, nella sua home: root non ci scrive.
  as_user bash -c '
    set -e; d="$HOME/.local/node"; mkdir -p "$HOME/.local"; rm -rf "$d.new"; mkdir "$d.new"
    tar -xJf "$1" -C "$d.new" --strip-components=1
    rm -rf "$d.old"; if [[ -d "$d" ]]; then mv "$d" "$d.old"; fi
    mv "$d.new" "$d"; rm -rf "$d.old"' _ "$tmp/$file"
  rm -rf "$tmp"
  # Node nel PATH anche per chi entra come l'utente (il servizio ha il suo PATH, in ciccio.service).
  as_user bash -c 'f="$HOME/.profile"; touch "$f"; sed -i "/^# BEGIN ciccio-node$/,/^# END ciccio-node$/d" "$f"
    printf "%s\n" "# BEGIN ciccio-node" "export PATH=\"\$HOME/.local/node/bin:\$PATH\"" "# END ciccio-node" >> "$f"'
  local d; d="$(check_node)" || die "$d"
  ok "$d"
}

# --- 5. tailscale --------------------------------------------------------------------------------------------------
check_tailscale() {
  command -v tailscale >/dev/null || { echo "non installato"; return 1; }
  [[ "$(ts_state)" == Running ]] || { echo "installato, non collegato alla tailnet"; return 1; }
  local name; name="$(ts_name)"
  [[ -n "$name" ]] || { echo "collegato, ma senza nome MagicDNS"; return 1; }
  [[ " $(ts_certs) " == *" $name "* ]] || { echo "$name: certificati HTTPS spenti nella tailnet"; return 1; }
  serve_ok || { echo "$name: tailscale serve non porta a Ciccio (127.0.0.1:$PORT)"; return 1; }
  echo "https://$name → 127.0.0.1:$PORT"
}
do_tailscale() {
  info "Tailscale è obbligatorio: Ciccio si apre dalla tua tailnet, in https con il certificato di Tailscale, mai"
  info "direttamente da internet. Serve un account Tailscale (gratuito per uso personale)."
  if ! command -v tailscale >/dev/null; then
    ask "Installo Tailscale dal suo repository apt ufficiale (pkgs.tailscale.com, pacchetti firmati)?" s || die "Tailscale è obbligatorio"
    local id codename base
    id="$(. /etc/os-release; echo "$ID")"; codename="$(. /etc/os-release; echo "$VERSION_CODENAME")"
    base="https://pkgs.tailscale.com/stable/$id/$codename"
    curl -fsSL "$base.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL "$base.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list
    grep -q 'signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg' /etc/apt/sources.list.d/tailscale.list \
      || die "l'elenco apt di Tailscale non è quello atteso (/etc/apt/sources.list.d/tailscale.list)"
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q tailscale
    systemctl enable --now tailscaled >/dev/null 2>&1
  fi
  if [[ "$(ts_state)" != Running ]]; then
    local h
    h="$(prompt "Nome del server nella tailnet (Ciccio sarà su https://<nome>.<tailnet>.ts.net)" "$(hostname -s | tr 'A-Z' 'a-z')")"
    [[ "$h" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "nome non valido: lettere minuscole, cifre e trattini"
    [[ -z "$YES" ]] || warn "tailscale up aspetta che apri il link qui sotto anche con --yes"
    info "Ora tailscale up stampa un link: aprilo da un browser e accedi al tuo account Tailscale."
    tailscale up --hostname="$h"
  fi
  [[ "$(ts_state)" == Running ]] || die "Tailscale non risulta collegato (tailscale status)"
  local name
  while true; do
    name="$(ts_name)"
    if [[ -n "$name" && " $(ts_certs) " == *" $name "* ]]; then break; fi
    warn "Nella console di Tailscale attiva MagicDNS e «HTTPS Certificates»: https://login.tailscale.com/admin/dns"
    info "Servono per l'indirizzo https del server, e le passkey funzionano solo in https."
    [[ -z "$YES" ]] || die "poi rilancia: sudo bash $0 --step tailscale"
    ask "Fatto? Ricontrollo" s || die "senza MagicDNS e HTTPS Ciccio non si apre"
    sleep 2
  done
  ok "MagicDNS e HTTPS attivi: $name"
  if ! serve_ok; then
    info "tailscale serve porta https://$name a Ciccio (127.0.0.1:$PORT), solo dentro la tailnet."
    ask "Lo attivo (tailscale serve --bg --https=443 http://127.0.0.1:$PORT)?" s || die "senza, Ciccio non si apre dalla tailnet"
    tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"
  fi
  # La prima richiesta fa emettere il certificato: può metterci qualche secondo.
  local code="000" i
  for i in 1 2 3 4; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "https://$name/" || true)"
    [[ "$code" != 000 ]] && break
    sleep 5
  done
  if [[ "$code" == 000 ]]; then warn "https://$name non risponde ancora (certificato in arrivo?): ricontrolla con curl -sI https://$name"
  else ok "https://$name risponde (HTTP $code; 502 finché Ciccio non è avviato)"; fi
}

# --- 6. linger -----------------------------------------------------------------------------------------------------
check_linger() {
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  [[ "$(loginctl show-user "$U" -p Linger --value 2>/dev/null || true)" == yes ]] || { echo "spento per $U"; return 1; }
  as_user systemctl --user show-environment >/dev/null 2>&1 || { echo "acceso, ma systemctl --user non risponde"; return 1; }
  echo "acceso, systemd di $U attivo"
}
do_linger() {
  need_user
  info "Ciccio è un servizio systemd di $U: con linger resta acceso dopo un riavvio, anche senza nessuno collegato."
  ask "Attivo linger per $U (loginctl enable-linger)?" s || die "senza, Ciccio si ferma quando esci dal server"
  loginctl enable-linger "$U"
  systemctl start "user@$UIDN.service" >/dev/null 2>&1 || true
  local i; for i in $(seq 1 20); do as_user systemctl --user show-environment >/dev/null 2>&1 && break; sleep 0.5; done
  as_user systemctl --user show-environment >/dev/null 2>&1 || die "systemctl --user non risponde per $U (XDG_RUNTIME_DIR=/run/user/$UIDN)"
  ok "linger acceso, systemctl --user risponde"
}

# --- 7. repo -------------------------------------------------------------------------------------------------------
check_repo() {
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  as_user test -d "$REPO_U/.git" || { echo "manca $REPO_U"; return 1; }
  echo "$REPO_U ($(as_user git -C "$REPO_U" log -1 --format='%h del %cd' --date=short 2>/dev/null || echo '?'))"
}
do_repo() {
  need_user
  local url="$PUBLIC_REPO" here
  here="$(cd "$SCRIPT_DIR/.." && pwd)"
  # Se setup.sh viene da un clone (anche di un fork), si clona dallo stesso indirizzo.
  if [[ -d "$here/.git" && "$here" != "$REPO_U" ]]; then
    local o; o="$(git -c safe.directory="$here" -C "$here" remote get-url origin 2>/dev/null || true)"
    [[ "$o" =~ ^https://[A-Za-z0-9./_~:-]+$ ]] && url="$o"
  fi
  if as_user test -e "$REPO_U"; then die "$REPO_U esiste ma non è un repo git: spostalo e riprova"; fi
  info "Il codice di Ciccio sta in $REPO_U, dell'utente $U (lo aggiorna lui con deploy/install.sh)."
  ask "Clono $url in $REPO_U?" s || die "serve il codice"
  as_login "git clone '$url' ~/ciccio"
  local d; d="$(check_repo)" || die "$d"
  ok "$d"
}

# --- 8. copia-root -------------------------------------------------------------------------------------------------
# Da dove prendere gli script di root: dal clone da cui root ha lanciato setup.sh; se setup.sh è già la copia di
# root, dal repo dell'utente (quindi codice che l'utente può aver cambiato: si mostrano le differenze).
root_src() { if [[ "$SCRIPT_DIR" == "$LIB" ]]; then echo "$REPO_U/deploy"; else echo "$SCRIPT_DIR"; fi; }
# I file nella home dell'utente si leggono come l'utente (un link simbolico non deve far leggere a root altro).
read_src() { if [[ -n "$HOME_U" && "$1" == "$HOME_U"/* ]]; then as_user cat -- "$1" > "$2"; else cat -- "$1" > "$2"; fi; }
check_copia_root() {
  local src f diff=() tmp; src="$(root_src)"
  [[ "$SCRIPT_DIR" != "$LIB" || -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  tmp="$(mktemp)"
  for f in "${ROOT_FILES[@]}"; do
    if ! read_src "$src/$f" "$tmp" 2>/dev/null; then diff+=("$f?"); continue; fi
    cmp -s "$tmp" "$LIB/$f" || diff+=("$f")
  done
  rm -f "$tmp"
  (( ${#diff[@]} == 0 )) || { echo "da aggiornare da $src: ${diff[*]}"; return 1; }
  echo "$LIB uguale a $src"
}
refresh_helpers() {
  local line inst helper src
  for line in "egress-helper.sh ciccio-egress-allow ciccio-egress-allow.sh" "apt-helper.sh ciccio-apt-install ciccio-apt-install.sh" \
              "ssh-helper.sh ciccio-ssh-allow ciccio-ssh-allow.sh"; do
    read -r inst helper src <<<"$line"
    if [[ -f "/usr/local/sbin/$helper" ]] && ! cmp -s "$LIB/$src" "/usr/local/sbin/$helper"; then
      bash "$LIB/$inst" "$U" | indent
    fi
  done
}
do_copia_root() {
  local src f tmp changed=() untrusted=0
  src="$(root_src)"
  [[ -n "$HOME_U" && "$src" == "$HOME_U"/* ]] && untrusted=1
  info "Root esegue solo script che l'utente di Ciccio non può modificare: copie in $LIB, prese da $src."
  tmp="$(mktemp -d)"
  for f in "${ROOT_FILES[@]}"; do
    read_src "$src/$f" "$tmp/$f" || die "non riesco a leggere $src/$f"
    if [[ ! -f "$LIB/$f" ]]; then changed+=("$f"); info "nuovo: $f"
    elif ! cmp -s "$tmp/$f" "$LIB/$f"; then
      changed+=("$f")
      diff -u --label "$LIB/$f" --label "$src/$f" "$LIB/$f" "$tmp/$f" | indent || true
    fi
  done
  if (( ${#changed[@]} == 0 )); then rm -rf "$tmp"; ok "$LIB è già aggiornata"; return 0; fi
  local def=s
  if (( untrusted )); then
    info "Provenienza: $src, $(as_user git -C "$REPO_U" log -1 --format='commit %h «%s» del %cd' --date=short 2>/dev/null || echo 'commit ?')"
    local dirty; dirty="$(as_user git -C "$REPO_U" status --porcelain -- deploy 2>/dev/null || true)"
    [[ -z "$dirty" ]] || warn "in deploy/ ci sono modifiche non committate: $(tr '\n' ' ' <<<"$dirty")"
    warn "Queste righe gireranno come root: leggile qui sopra. Vengono dalla cartella di $U (con --yes non si installano)."
    def=n
  fi
  ask "Installo come root in $LIB: ${changed[*]}?" "$def" || { rm -rf "$tmp"; warn "copia di root non aggiornata"; return 0; }
  install -d -o root -g root -m 755 "$LIB"
  for f in "${changed[@]}"; do install -o root -g root -m 755 "$tmp/$f" "$LIB/$f"; done
  rm -rf "$tmp"
  [[ -z "$UIDN" ]] || refresh_helpers
  ok "copia di root aggiornata: $LIB"
}
ensure_lib() { [[ -f "$LIB/egress-firewall.sh" ]] || run_step copia-root; [[ -f "$LIB/egress-firewall.sh" ]] || die "manca la copia di root $LIB"; }

# --- 9. ciccio (parte dell'utente) ---------------------------------------------------------------------------------
check_ciccio() {
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  as_user test -f "$HOME_U/.config/ciccio.env" || { echo "manca ~$U/.config/ciccio.env"; return 1; }
  [[ -n "$(user_env CICCIO_OWNER_NAME)" && -n "$(user_env CICCIO_ORIGINS)" ]] || { echo "ciccio.env senza nome o indirizzi"; return 1; }
  as_login 'gh auth status' >/dev/null 2>&1 || { echo "GitHub non collegato (gh auth login)"; return 1; }
  as_user systemctl --user is-active --quiet ciccio.service || { echo "servizio ciccio spento"; return 1; }
  local st; st="$(claude_status)"
  [[ "$st" == ok* ]] || { echo "manca il login di claude.ai ($st)"; return 1; }
  echo "servizio attivo per $(user_env CICCIO_OWNER_NAME), da $(user_env CICCIO_ORIGINS)"
}
# Claude Code arriva con l'Agent SDK (pacchetto per piattaforma, dopo install.sh): serve per il login di claude.ai.
claude_bin() {
  local a; case "$(uname -m)" in x86_64) a=x64 ;; aarch64) a=arm64 ;; *) return 0 ;; esac
  as_user bash -c 'ls "$HOME"/ciccio/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-"$1"@*/node_modules/@anthropic-ai/claude-agent-sdk-linux-"$1"/claude 2>/dev/null | tail -1' _ "$a" || true
}
# «ok (abbonamento)», «no», «a consumo (metodo)» o «senza claude»: Ciccio usa solo il login con l'abbonamento.
# claude auth status esce con errore senza login: || true, o set -e fermerebbe il passo in silenzio.
claude_status() {
  local b; b="$(claude_bin)"
  [[ -n "$b" ]] || { echo "senza claude: prima install.sh"; return 0; }
  as_login "'$b' auth status" 2>/dev/null | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("stato sconosciuto"); sys.exit()
m=str(d.get("authMethod") or "")
if not d.get("loggedIn"): print("no")
elif any(w in m.lower() for w in ("api","console")): print("a consumo (%s)" % m)
else: print("ok (%s)" % (d.get("subscriptionType") or m))' || true
}
do_ciccio() {
  need_user
  as_user test -d "$REPO_U/.git" || run_step repo
  local name changed=0 cur v
  name="$(ts_name)"; [[ "$name" =~ ^[a-z0-9.-]+$ ]] || die "prima Tailscale: sudo bash $0 --step tailscale"

  # ciccio.env commentato, da install.sh (un solo modello per tutti).
  if ! as_user test -f "$HOME_U/.config/ciccio.env"; then
    info "Scrivo ~/.config/ciccio.env, commentato: ogni variabile con il suo default."
    as_login "cd ~/ciccio && CICCIO_ORIGINS='https://$name' bash deploy/install.sh env" | indent
  fi

  # Nome.
  cur="$(user_env CICCIO_OWNER_NAME)"
  v="$(prompt "Il tuo nome (Ciccio e gli agenti ti chiamano così)" "$cur")"
  [[ -n "$v" && ${#v} -le 60 && ! "$v" =~ [\"\\\$\`] ]] || die "nome non valido (niente virgolette, \\, \$ o \`)"
  if [[ "$v" != "$cur" ]]; then printf '%s\n' "$v" | set_env CICCIO_OWNER_NAME; changed=1; fi

  # Indirizzi: quello della tailnet sempre, primo se non c'è altro.
  cur="$(user_env CICCIO_ORIGINS)"; v="${cur:-https://$name}"
  [[ ",$v," == *",https://$name,"* ]] || v="https://$name,$v"
  v="$(prompt "Indirizzi da cui apri Ciccio, separati da virgola (il primo è quello dei link)" "$v")"
  local o; IFS=, read -ra o <<<"$v"
  for cur_o in "${o[@]}"; do [[ "$cur_o" =~ ^https://[a-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "indirizzo non valido: $cur_o (serve https://nome)"; done
  if [[ "$v" != "$(user_env CICCIO_ORIGINS)" ]]; then printf '%s\n' "$v" | set_env CICCIO_ORIGINS; changed=1; fi

  # Fuso orario.
  cur="$(user_env CICCIO_TZ)"
  v="${cur:-$(timedatectl show -p Timezone --value 2>/dev/null || true)}"
  [[ -n "$v" && "$v" != Etc/UTC && "$v" != UTC ]] || v=Europe/Rome
  v="$(prompt "Fuso orario per orari, routine e riepilogo (es. Europe/Rome)" "$v")"
  [[ "$v" =~ ^[A-Za-z0-9_+/-]+$ && -f "/usr/share/zoneinfo/$v" ]] || die "fuso orario sconosciuto: $v (elenco: timedatectl list-timezones)"
  if [[ "$v" != "$cur" ]]; then printf '%s\n' "$v" | set_env CICCIO_TZ; changed=1; fi

  # GitHub: gh per gli agenti (clone, push, PR) e come aiuto credenziali di git.
  if as_login 'gh auth status' >/dev/null 2>&1; then ok "GitHub già collegato"
  elif [[ -n "$YES" ]]; then warn "GitHub da collegare a mano (serve il browser): sudo bash $0 --step ciccio"
  else
    info "GitHub: gli agenti clonano, fanno push e aprono PR con gh. Si collega dal browser con un codice di una volta."
    if ask "Collego GitHub adesso (gh auth login --web)?" s; then
      as_login 'gh auth login --web --git-protocol https --hostname github.com && gh auth setup-git' \
        || warn "GitHub non collegato. Dopo, come $U: gh auth login --web --git-protocol https && gh auth setup-git"
    fi
  fi

  # Identità git dei commit degli agenti.
  if [[ -z "$(as_user git config --global user.name 2>/dev/null || true)" ]]; then
    local login="" gname="" gid="" gmail=""
    if as_login 'gh auth status' >/dev/null 2>&1; then
      IFS=$'\t' read -r login gname gid gmail < <(as_login "gh api user --jq '[.login, (.name // .login), (.id|tostring), (.email // \"\")] | join(\"\\t\")'" 2>/dev/null || true) || true
    fi
    [[ -n "$gmail" || -z "$login" ]] || gmail="$gid+$login@users.noreply.github.com"
    info "Nome ed email dei commit degli agenti (git config --global di $U)."
    v="$(prompt "Nome per i commit" "${gname:-$U}")"
    local e; e="$(prompt "Email per i commit" "${gmail:-$U@$(hostname -f 2>/dev/null || hostname)}")"
    as_user git config --global user.name "$v"
    as_user git config --global user.email "$e"
    ok "git: $v <$e>"
  fi

  # Compilazione e avvio.
  if as_user systemctl --user is-active --quiet ciccio.service; then
    if ask "Ciccio è già avviato: lo aggiorno e riavvio (deploy/install.sh)?" n; then run_install
    elif (( changed )); then restart_ciccio; ok "Ciccio riavviato con la configurazione nuova"; fi
  else
    ask "Compilo e avvio Ciccio (deploy/install.sh, qualche minuto)?" s || { warn "Ciccio non avviato"; return 0; }
    run_install
  fi
  local i code=000
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 3 "http://127.0.0.1:$PORT/" || true)"
    [[ "$code" != 000 ]] && break; sleep 1
  done
  [[ "$code" != 000 ]] || die "Ciccio non risponde su 127.0.0.1:$PORT. Registro, come $U: journalctl --user -u ciccio -n 50"
  ok "Ciccio risponde su 127.0.0.1:$PORT"

  # Login di claude.ai: Ciccio e gli agenti lavorano con l'abbonamento di chi installa (niente chiavi API).
  local st b; st="$(claude_status)"; b="$(claude_bin)"
  if [[ "$st" == ok* ]]; then ok "claude.ai collegato: $st"; return 0; fi
  [[ -n "$b" ]] || die "non trovo Claude Code in ~$U/ciccio/node_modules: install.sh è andato a buon fine?"
  [[ "$st" == no ]] || warn "Claude Code risulta collegato $st: Ciccio usa solo il login con l'abbonamento claude.ai"
  if [[ -n "$YES" ]]; then warn "login di claude.ai da fare a mano (serve il browser): sudo bash $0 --step ciccio"; return 0; fi
  info "Claude: Ciccio e gli agenti usano il tuo abbonamento claude.ai (Pro, Max, Team o Enterprise), con il login di $U."
  info "Il comando stampa un link: aprilo nel browser, accedi, poi incolla qui il codice che ti mostra."
  ask "Faccio il login adesso?" s || { warn "senza login gli agenti non partono. Dopo, come $U: $b auth login --claudeai"; return 0; }
  as_login "'$b' auth login --claudeai" || warn "login non riuscito. Riprova come $U: $b auth login --claudeai"
  st="$(claude_status)"
  [[ "$st" == ok* ]] || { warn "claude.ai non collegato ($st): sudo bash $0 --step ciccio per riprovare"; return 0; }
  restart_ciccio
  ok "claude.ai collegato: $st (Ciccio riavviato)"
}
run_install() { as_login 'cd ~/ciccio && bash deploy/install.sh' || die "install.sh non è riuscito: guarda i messaggi qui sopra"; }

# --- 10. firewall --------------------------------------------------------------------------------------------------
ufw_active() { ufw status 2>/dev/null | grep -q '^Status: active'; }
check_firewall() {
  command -v ufw >/dev/null || { echo "manca ufw"; return 1; }
  ufw_active || { echo "ufw spento"; return 1; }
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  ufw status | grep -q 'tailscale0' || { echo "ufw non lascia entrare dalla tailnet (tailscale0)"; return 1; }
  iptables -S ufw-before-output 2>/dev/null | grep -q -- "--uid-owner $UIDN -j REJECT" || { echo "ufw attivo, ma senza le regole per $U"; return 1; }
  systemctl is-active --quiet tinyproxy || { echo "proxy tinyproxy spento"; return 1; }
  echo "attivo: $U esce solo dal proxy 127.0.0.1:8888 (domini in /etc/tinyproxy/ciccio-allow)"
}
verify_firewall() {
  if as_user curl -s -o /dev/null --noproxy '*' --max-time 8 https://example.com; then
    die "$U raggiunge ancora example.com direttamente: il firewall in uscita non funziona"
  fi
  ok "connessione diretta bloccata (example.com)"
  if as_user curl -s -o /dev/null --max-time 15 --proxy http://127.0.0.1:8888 https://example.com; then
    warn "example.com passa dal proxy: è tra i domini consentiti?"
  else ok "example.com rifiutato anche dal proxy"; fi
  local code; code="$(as_user curl -s -o /dev/null -w '%{http_code}' --max-time 20 --proxy http://127.0.0.1:8888 https://api.anthropic.com/v1/models || true)"
  [[ "$code" =~ ^(200|401|403|404)$ ]] || die "api.anthropic.com non risponde dal proxy (HTTP $code): vedi /var/log/tinyproxy/tinyproxy.log"
  ok "api.anthropic.com raggiungibile dal proxy (HTTP $code senza chiave, come previsto)"
}
do_firewall() {
  need_user
  info "Firewall in uscita: $U, e quindi gli agenti, raggiunge internet solo da un proxy locale e solo i domini"
  info "consentiti (Anthropic, GitHub, npm, PyPI…); gli altri li approvi tu, uno per uno."
  ask "Lo attivo?" s || { warn "saltato: gli agenti possono raggiungere qualsiasi indirizzo"; return 0; }
  ensure_lib
  command -v ufw >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q ufw
  if ! ufw_active; then
    local ports
    ports="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -u | tr '\n' ' ')"; ports="${ports:-22 }"
    info "ufw è spento. Per accenderlo lascio entrare: SSH (porta ${ports% }), tutto dalla tailnet (tailscale0) e"
    info "41641/udp (connessioni dirette di Tailscale). Tutto il resto in arrivo resta chiuso."
    warn "Se entri in SSH da una porta diversa, o il provider filtra a modo suo, potresti restare chiuso fuori:"
    warn "tieni aperta una seconda sessione SSH finché non hai controllato di poter rientrare."
    ask "Accendo ufw con queste regole?" s || { warn "firewall in uscita non attivo: serve ufw acceso"; return 0; }
    if [[ "${ports% }" == 22 ]] && ufw app info OpenSSH >/dev/null 2>&1; then ufw allow OpenSSH >/dev/null
    else local p; for p in $ports; do ufw allow "$p/tcp" comment 'SSH' >/dev/null; done; fi
    ufw allow in on tailscale0 comment 'Tailscale' >/dev/null
    ufw allow 41641/udp comment 'Tailscale, connessioni dirette' >/dev/null
    ufw --force enable >/dev/null
    ok "ufw acceso"
  elif ! ufw status | grep -q 'tailscale0'; then
    ufw allow in on tailscale0 comment 'Tailscale' >/dev/null
    ok "ufw: aperto l'ingresso dalla tailnet (tailscale0)"
  fi
  bash "$LIB/egress-firewall.sh" "$U" | indent
  verify_firewall
}

# --- 11. helper ----------------------------------------------------------------------------------------------------
HELPERS=(
  "egress-helper.sh|ciccio-egress-allow|ciccio-egress-allow.sh|Domini nuovi su richiesta: un agente chiede un dominio (consenti_dominio), tu approvi in chat, l'helper lo apre nel proxy."
  "apt-helper.sh|ciccio-apt-install|ciccio-apt-install.sh|Programmi di sistema su richiesta: un agente chiede un pacchetto (installa_programma), tu approvi, l'helper installa solo pacchetti ufficiali di Ubuntu."
  "ssh-helper.sh|ciccio-ssh-allow|ciccio-ssh-allow.sh|Server SSH dalle Impostazioni: aggiungi un server pubblico che gli agenti raggiungono in SSH, senza root a mano."
)
check_helper() {
  local e on=() off=() inst helper src d
  for e in "${HELPERS[@]}"; do
    IFS='|' read -r inst helper src d <<<"$e"
    if [[ -f "/usr/local/sbin/$helper" ]]; then on+=("$helper"); else off+=("$helper"); fi
  done
  (( ${#off[@]} )) || { echo "attivi: ${on[*]}"; return 0; }
  echo "${on[*]:+attivi: ${on[*]}; }spenti: ${off[*]} (facoltativi)"; return 2
}
do_helper() {
  need_user
  ensure_lib
  local e inst helper src d
  for e in "${HELPERS[@]}"; do
    IFS='|' read -r inst helper src d <<<"$e"
    if [[ -f "/usr/local/sbin/$helper" ]] && cmp -s "$LIB/$src" "/usr/local/sbin/$helper"; then ok "$helper attivo"; continue; fi
    info "$d"
    if [[ "$helper" == ciccio-egress-allow && ! -f /etc/tinyproxy/ciccio-allow ]]; then warn "serve prima il firewall in uscita (--step firewall)"; continue; fi
    if ask "Attivo $helper (una regola sudo che permette a $U solo quel comando)?" s; then
      bash "$LIB/$inst" "$U" | indent
      visudo -c >/dev/null || die "visudo segnala un errore nelle regole sudo"
      ok "$helper attivo"
    fi
  done
}

# --- 12. schermo ---------------------------------------------------------------------------------------------------
check_schermo() {
  [[ -x /usr/bin/Xvfb ]] || { echo "Xvfb non installato (facoltativo)"; return 2; }
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  as_user systemctl --user is-active --quiet ciccio-display.service || { echo "Xvfb installato, ciccio-display spento"; return 1; }
  echo "schermo virtuale :50 attivo"
}
do_schermo() {
  need_user
  info "Schermo virtuale (Xvfb, display :50) per i programmi grafici degli agenti: OpenSCAD, FreeCAD, grafici, browser."
  if [[ ! -x /usr/bin/Xvfb ]]; then
    ask "Installo xvfb?" n || return 0
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends xvfb xauth
  fi
  as_user test -f "$REPO_U/deploy/ciccio-display.service" || die "manca $REPO_U (--step repo)"
  as_user bash -c 'set -e; mkdir -p ~/.config/systemd/user
    cp ~/ciccio/deploy/ciccio-display.service ~/.config/systemd/user/
    mkdir -p ~/.local/bin && install -m 755 ~/ciccio/deploy/xvfb-run.sh ~/.local/bin/xvfb-run
    systemctl --user daemon-reload && systemctl --user enable --now ciccio-display.service >/dev/null'
  local d; d="$(check_schermo)" || die "$d"
  ok "$d"
}

# --- 13. voce ------------------------------------------------------------------------------------------------------
# Modelli da Hugging Face a revisioni fisse, con l'impronta sha256 di ogni file: se cambiano, non si installano.
WHISPER_REV=ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66   # Systran/faster-whisper-base
PIPER_REV=5041a7a49ae5b3a0f30e6837769eb03fdbb231bd     # rhasspy/piper-voices
HF=https://huggingface.co
VOICE_FILES=(
  "whisper-base/config.json|$HF/Systran/faster-whisper-base/resolve/$WHISPER_REV/config.json|56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a"
  "whisper-base/model.bin|$HF/Systran/faster-whisper-base/resolve/$WHISPER_REV/model.bin|d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9"
  "whisper-base/tokenizer.json|$HF/Systran/faster-whisper-base/resolve/$WHISPER_REV/tokenizer.json|fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"
  "whisper-base/vocabulary.txt|$HF/Systran/faster-whisper-base/resolve/$WHISPER_REV/vocabulary.txt|34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"
  "piper/it_IT-paola-medium.onnx|$HF/rhasspy/piper-voices/resolve/$PIPER_REV/it/it_IT/paola/medium/it_IT-paola-medium.onnx|6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c"
  "piper/it_IT-paola-medium.onnx.json|$HF/rhasspy/piper-voices/resolve/$PIPER_REV/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json|aea19c0a7fce29fbc359b93f10e7902854401e4c95ae2ea328ae516b15d296cf"
  "piper/it_IT-riccardo-x_low.onnx|$HF/rhasspy/piper-voices/resolve/$PIPER_REV/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx|1368de15f123275a7ef951c9e5e30be0f58a032daa14a0da44037443c1d1d21b"
  "piper/it_IT-riccardo-x_low.onnx.json|$HF/rhasspy/piper-voices/resolve/$PIPER_REV/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx.json|146ab9c634afe524e9fb7530f2510df7a42fb1db56b52658ca1fb3d98001a62a"
)
check_voce() {
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  if as_user systemctl --user is-active --quiet ciccio-voice.service; then echo "attiva (Whisper base, Piper)"; return 0; fi
  echo "non attiva (facoltativa)"; return 2
}
download_voice_models() {
  local models="$HOME_U/.ciccio/voice-models" tmp e dest url sum
  tmp="$(mktemp -d)"; chmod 755 "$tmp"
  for e in "${VOICE_FILES[@]}"; do
    IFS='|' read -r dest url sum <<<"$e"
    if [[ "$(as_user sha256sum "$models/$dest" 2>/dev/null | cut -d' ' -f1)" == "$sum" ]]; then ok "$dest già presente"; continue; fi
    info "scarico $dest"
    # Lo scarica root, che il firewall in uscita non limita; il file lo installa poi l'utente nella sua home.
    curl -fL --retry 3 --progress-bar "$url" -o "$tmp/file" || die "scaricamento non riuscito: $url"
    echo "$sum  $tmp/file" | sha256sum -c --quiet - || die "l'impronta di $dest non è quella attesa: non lo installo"
    chmod 644 "$tmp/file"
    as_user install -D -m 644 "$tmp/file" "$models/$dest"
    rm -f "$tmp/file"
  done
  rm -rf "$tmp"
  ok "modelli controllati (sha256) in $models"
}
do_voce() {
  need_user
  info "Voce sul server: trascrizione (faster-whisper) e sintesi (Piper) in locale, ~240 MB di modelli da Hugging Face,"
  info "un servizio che usa fino a 2 GB di RAM. In alternativa la voce del browser o un servizio esterno (Impostazioni › Voce)."
  ask "Installo la voce?" n || return 0
  dpkg-query -W -f='${db:Status-Status}' python3-venv 2>/dev/null | grep -q installed \
    || DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends python3-venv
  download_voice_models
  # Pacchetti Python da PyPI (consentito dal firewall in uscita), come l'utente.
  as_login 'cd ~/ciccio && bash deploy/install-voice.sh' || die "install-voice.sh non è riuscito"
  local d rc=0; d="$(check_voce)" || rc=$?
  (( rc == 0 )) || die "il servizio voce non è partito: come $U, journalctl --user -u ciccio-voice -n 30"
  ok "$d"
}

# --- 14. dominio ---------------------------------------------------------------------------------------------------
public_origins() { user_env CICCIO_ORIGINS | tr ',' '\n' | grep -v '\.ts\.net$' | grep . || true; }
check_dominio() {
  [[ -n "$UIDN" ]] || { echo "manca l'utente"; return 1; }
  local p; p="$(public_origins | tr '\n' ' ')"
  [[ -n "$p" ]] && { echo "anche da: $p"; return 0; }
  echo "solo dalla tailnet (un dominio pubblico è facoltativo)"; return 2
}
do_dominio() {
  need_user
  info "Dominio pubblico (facoltativo): Ciccio anche da https://tuo-dominio, dietro un reverse proxy come Caddy,"
  info "senza Tailscale sul dispositivo. Il login con la passkey resta obbligatorio, da qualunque rete."
  ask "Aggiungo un dominio pubblico?" n || return 0
  local d; d="$(prompt "Dominio (es. ciccio.example.com)" "")"
  d="${d,,}"; d="${d#https://}"; d="${d%/}"
  [[ "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "dominio non valido: $d"
  local here=0 name; name="$(ts_name)"
  ask "Il reverse proxy (Caddy) gira su questo server?" s && here=1
  info "Configurazione per Caddy (Caddyfile), da adattare se usi altro; Caddy inoltra da sé anche i websocket"
  info "(/ws, /companion, /desktop) e prende il certificato. Il DNS di $d deve puntare a quel server."
  echo
  if (( here )); then
    printf '%s\n' "$d {" "	reverse_proxy 127.0.0.1:$PORT" "}" | indent
  else
    printf '%s\n' "$d {" "	# Da un'altra macchina della tailnet: passa da tailscale serve di questo server." \
      "	reverse_proxy https://$name {" "		header_up Host {upstream_hostport}" "	}" "}" | indent
  fi
  echo
  info "Per installare Caddy: https://caddyserver.com/docs/install"
  if (( here )) && ufw_active && ! ufw status | grep -qE '^(80,443/tcp|443/tcp)'; then
    ask "Apro 80 e 443 in ufw per Caddy (certificato e https)?" s && { ufw allow 80,443/tcp comment 'Caddy' >/dev/null; ok "ufw: 80 e 443 aperte"; }
  fi
  local cur; cur="$(user_env CICCIO_ORIGINS)"
  if [[ ",$cur," != *",https://$d,"* ]]; then
    printf '%s\n' "${cur:+$cur,}https://$d" | set_env CICCIO_ORIGINS
    restart_ciccio
  fi
  ok "https://$d aggiunto a CICCIO_ORIGINS (le passkey vanno create anche da lì: ogni indirizzo ha le sue)"
}

# --- 15. fine ------------------------------------------------------------------------------------------------------
check_fine() { echo "codice di attivazione e prossimi passi"; return 1; }
do_fine() {
  need_user
  as_user systemctl --user is-active --quiet ciccio.service || die "Ciccio non è avviato: sudo bash $0 --step ciccio"
  local origin out; origin="$(user_env CICCIO_ORIGINS)"; origin="${origin%%,*}"
  if out="$(as_login 'cd ~/ciccio && bash deploy/install.sh code' 2>&1)"; then printf '%s\n' "$out" | indent
  else warn "codice non disponibile: $(tail -2 <<<"$out" | tr '\n' ' ')"; fi
  cat <<EOF

   Prossimi passi
   1. Installa Tailscale sul telefono e sul PC, con lo stesso account, e apri $origin.
      Inserisci il codice qui sopra e crea la passkey (Face ID, Touch ID, impronta o PIN).
   2. Altri dispositivi: da uno già collegato, Impostazioni › Accesso › nuovo codice.
   3. PC: companion (programmi del PC per gli agenti) e app desktop si collegano da Impostazioni, con un codice.
   4. Progetti: come $U (sudo -iu $U), clona i repo in ~/projects: ognuno diventa un agente.
   5. Aggiornare: come $U, cd ~/ciccio && bash deploy/install.sh. Script di root: sudo bash $LIB/setup.sh --step copia-root.
   6. Nessun dispositivo collegato, o passkey persa: come $U, bash ~/ciccio/deploy/install.sh code.
   Stato in ogni momento: sudo bash $LIB/setup.sh --check
EOF
}

# =====================================================================================================================
run_step() {
  local s="$1" fn="${1//-/_}" detail rc=0
  title "$s: ${DESC[$s]}"
  detail="$("check_$fn")" || rc=$?
  if (( rc == 0 )); then
    ok "$detail"
    if [[ "$ONLY" == "$s" ]] && ask "Già a posto. Lo rifaccio?" n; then "do_$fn"; fi
    return 0
  fi
  info "$detail"
  "do_$fn"
}
status_table() {
  local s fn detail rc label col
  printf '%s%-11s %-8s %s%s\n' "$BOLD" passo stato dettaglio "$OFF"
  for s in "${STEPS[@]}"; do
    [[ "$s" == fine ]] && continue
    fn="${s//-/_}"; rc=0; detail="$("check_$fn" 2>/dev/null)" || rc=$?
    case $rc in 0) label=ok; col="$GRN" ;; 2) label=facolt.; col="$DIM" ;; *) label="da fare"; col="$YEL" ;; esac
    printf '%-11s %s%-8s%s %s\n' "$s" "$col" "$label" "$OFF" "$detail"
  done
}

load_user
if [[ -n "$CHECK" ]]; then status_table; exit 0; fi

# Root non dovrebbe eseguire codice che l'utente di Ciccio può modificare.
if [[ -n "$HOME_U" && ( "$SCRIPT_DIR" == "$HOME_U"/* || "$(stat -c %U "$SELF")" == "$U" ) ]]; then
  warn "Questo setup.sh è nella cartella di $U, che il server di Ciccio (o chi lo controllasse) può modificare."
  [[ -f "$LIB/setup.sh" ]] && warn "Usa la copia di root: sudo bash $LIB/setup.sh"
  ask "Continuo con questa copia (dopo aver controllato git -C $REPO_U status)?" n || exit 1
fi

printf '%sCiccio: installazione guidata%s (%s)\n' "$BOLD" "$OFF" "${ONLY:-tutti i passi}"
[[ -z "$YES" ]] || info "--yes: ogni domanda prende la risposta di default."
if [[ -n "$ONLY" ]]; then run_step "$ONLY"
else for s in "${STEPS[@]}"; do run_step "$s"; done; fi
echo
