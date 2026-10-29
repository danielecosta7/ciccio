#!/usr/bin/env bash
# Firewall in uscita per l'utente che esegue Ciccio e gli agenti.
#
# L'utente non può aprire connessioni verso internet: passa solo da un proxy locale
# (tinyproxy su 127.0.0.1:8888) che lascia uscire soltanto i domini nell'elenco qui sotto
# e registra ogni connessione in /var/log/tinyproxy/tinyproxy.log.
#
# Root esegue la copia di root (/usr/local/lib/ciccio, messa da setup.sh), non quella in ~utente/ciccio,
# che l'utente di Ciccio può modificare.
#
# Uso (come root):  bash egress-firewall.sh [utente]              applica
#                   bash egress-firewall.sh [utente] --rules-only solo le regole (es. dopo ciccio-ssh-allow)
#                   bash egress-firewall.sh [utente] --remove     annulla
# Senza utente: quello in /etc/ciccio/user (setup.sh), altrimenti il proprietario del repo da cui si lancia.
set -euo pipefail

USER_NAME=""; MODE=apply
for a in "$@"; do case "$a" in --*) MODE="$a" ;; *) USER_NAME="$a" ;; esac; done
[[ "$MODE" == apply || "$MODE" == --rules-only || "$MODE" == --remove ]] || { echo "Opzione sconosciuta: $MODE" >&2; exit 1; }
if [[ -z "$USER_NAME" ]]; then
  if [[ -s /etc/ciccio/user ]]; then USER_NAME="$(head -1 /etc/ciccio/user)"
  else USER_NAME="$(stat -c %U "$(cd "$(dirname "$0")/.." && pwd)")"; fi
fi
[[ $EUID -eq 0 ]] || { echo "Da eseguire come root." >&2; exit 1; }
[[ "$USER_NAME" != root ]] || { echo "L'utente di Ciccio non può essere root (passalo come argomento)." >&2; exit 1; }
UID_NUM="$(id -u "$USER_NAME")"
PROXY="http://127.0.0.1:8888"
BEGIN="# BEGIN ciccio-egress"
END="# END ciccio-egress"
SELF="$(readlink -f "$0")"
if [[ "$(stat -c %U "$SELF")" == "$USER_NAME" ]]; then
  echo "Attenzione: $SELF è dell'utente $USER_NAME, che può modificarlo. Usa la copia di root: /usr/local/lib/ciccio/egress-firewall.sh" >&2
fi

# Domini consentiti (espressioni regolari estese sul nome host).
ALLOW=(
  '(^|\.)anthropic\.com$'          # API Claude, login
  '(^|\.)claude\.ai$'              # login di claude.ai e connettori (se usi l'abbonamento)
  '(^|\.)claude\.com$'
  '(^|\.)github\.com$'             # git, gh, API (anche api.github.com per deploy/fetch-release.sh)
  '(^|\.)githubusercontent\.com$'  # file grezzi e file delle release (release-assets., objects.githubusercontent.com)
  '^registry\.npmjs\.org$'         # pacchetti npm / pnpm
  '^registry\.yarnpkg\.com$'
  '^nodejs\.org$'                  # header nativi e corepack
  '^pypi\.org$'                    # pacchetti Python
  '^files\.pythonhosted\.org$'
  '^cdn\.sheetjs\.com$'            # pacchetto xlsx di SheetJS (non è più aggiornato su npm)
  '^export-download\.canva\.com$'  # file esportati dal connettore Canva (MP4, PNG, PDF)
  '^api\.openai\.com$'             # voce esterna (solo se collegata nelle Impostazioni › Voce)
  '^api\.elevenlabs\.io$'
  '^api\.deepgram\.com$'
)

strip_block() { sed -i "/^$BEGIN\$/,/^$END\$/d" "$1"; }

# File nella home dell'utente: li modifica l'utente stesso (runuser), mai root, così un link simbolico messo
# lì non fa scrivere root altrove. $1 file, $2 contenuto del blocco ('' = solo togliere), $3 1 = solo se esiste.
user_block() {
  cd / && runuser -u "$USER_NAME" -- bash -c '
    set -e; f="$1"; b="$2"; e="$3"; body="$4"; only="$5"
    if [[ ! -f "$f" ]]; then [[ -n "$body" && "$only" != 1 ]] || exit 0; : > "$f"; fi
    sed -i "/^$b\$/,/^$e\$/d" "$f"
    if [[ -n "$body" ]]; then printf "%s\n%s\n%s\n" "$b" "$body" "$e" >> "$f"; fi' _ "$1" "$BEGIN" "$END" "${2:-}" "${3:-0}"
}
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
restart_ciccio() {
  (cd / && runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="/run/user/$UID_NUM" systemctl --user try-restart ciccio.service) || true
}

if [[ "$MODE" == "--remove" ]]; then
  for f in /etc/ufw/before.rules /etc/ufw/before6.rules; do strip_block "$f"; done
  ufw reload >/dev/null || true
  for f in "$HOME_DIR/.profile" "$HOME_DIR/.bashrc" "$HOME_DIR/.config/ciccio.env"; do user_block "$f" "" 1; done
  restart_ciccio
  echo "Firewall in uscita rimosso per $USER_NAME (tinyproxy resta installato: apt remove tinyproxy per toglierlo)."
  exit 0
fi

# Con ufw spento le regole qui sotto non avrebbero effetto: meglio fermarsi che dire «attivo».
if ! ufw status 2>/dev/null | grep -q '^Status: active'; then
  cat >&2 <<EOF
ufw non è attivo: le regole del firewall in uscita non avrebbero effetto. Prima, come root:
  ufw allow OpenSSH            # (o la porta del tuo SSH) per non restare chiuso fuori
  ufw allow in on tailscale0   # Ciccio dalla tailnet
  ufw enable
oppure lascia fare a setup.sh: sudo bash /usr/local/lib/ciccio/setup.sh --step firewall
EOF
  exit 1
fi

# 1. Proxy con elenco di domini consentiti (saltato con --rules-only: solo le regole del firewall, senza riavvii).
if [[ "$MODE" != "--rules-only" ]]; then
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tinyproxy >/dev/null
# Elenco fisso qui sopra, più i domini che l'utente ha approvato agli agenti (consenti_dominio, deploy/egress-helper.sh).
printf '%s\n' "${ALLOW[@]}" | sed 's/[[:space:]]*#.*$//' > /etc/tinyproxy/ciccio-allow-base
mkdir -p /etc/ciccio && touch /etc/ciccio/egress-extra && chmod 644 /etc/ciccio/egress-extra
{ cat /etc/tinyproxy/ciccio-allow-base; awk -F'\t' '!/^#/ && NF { print $1 }' /etc/ciccio/egress-extra; } > /etc/tinyproxy/ciccio-allow
cat > /etc/tinyproxy/tinyproxy.conf <<'EOF'
# Gestito da Ciccio (deploy/egress-firewall.sh)
User tinyproxy
Group tinyproxy
Port 8888
Listen 127.0.0.1
Timeout 900
# Ogni agente al lavoro tiene aperte più connessioni verso Anthropic: con 100 il proxy si riempiva
# e rifiutava le nuove (gh, npm…) quando lavoravano molti agenti insieme.
MaxClients 500
Allow 127.0.0.1
ConnectPort 443
ConnectPort 80
Filter "/etc/tinyproxy/ciccio-allow"
FilterType ere
FilterURLs Off
FilterCaseSensitive Off
FilterDefaultDeny Yes
DisableViaHeader Yes
LogFile "/var/log/tinyproxy/tinyproxy.log"
LogLevel Connect
PidFile "/run/tinyproxy/tinyproxy.pid"
EOF
systemctl enable --now tinyproxy >/dev/null 2>&1
systemctl restart tinyproxy
fi

# 2. L'utente può parlare solo con localhost (proxy, Ciccio) e rispondere alle connessioni in arrivo.
#    Eccezione: SSH verso i server in /etc/ciccio/ssh-hosts (un "host" o "host:porta" per riga, gestito da
#    ciccio-ssh-allow), per gli agenti che usano le chiavi SSH di 1Password. I nomi si risolvono adesso: se un IP
#    cambia, rilancia lo script. Gli indirizzi interni (reti private, tailnet, link-local) passano solo per i server
#    che root ha segnato in /etc/ciccio/ssh-hosts-private (ssh-hosts.sh add host --privato).
SSH_HOSTS=/etc/ciccio/ssh-hosts
SSH_PRIVATE=/etc/ciccio/ssh-hosts-private
mkdir -p /etc/ciccio
[[ -f "$SSH_HOSTS" ]] || printf '# Server raggiungibili in SSH dagli agenti di Ciccio: host o host:porta, uno per riga.\n' > "$SSH_HOSTS"
chmod 644 "$SSH_HOSTS"
canon() { local e="${1,,}"; printf '%s' "${e%:22}"; }
# Prima volta: i server già in elenco li aveva messi root (prima non c'era l'helper), quindi valgono anche se interni.
if [[ ! -f "$SSH_PRIVATE" ]]; then
  { echo "# Server SSH che root ha consentito anche se interni (reti private, tailnet). Uno per riga, come in ssh-hosts."
    sed 's/[[:space:]]*#.*$//' "$SSH_HOSTS" | while read -r e; do if [[ -n "$e" ]]; then canon "$e"; echo; fi; done; } > "$SSH_PRIVATE"
fi
chmod 644 "$SSH_PRIVATE"
# Indirizzi interni (uguale in ciccio-ssh-allow.sh): 0 = interno.
ip4_internal() {
  local a b c d; IFS=. read -r a b c d <<<"$1"
  (( a == 0 || a == 10 || a == 127 || a >= 224 )) && return 0
  (( a == 100 && b >= 64 && b <= 127 )) && return 0   # CGNAT, Tailscale
  (( a == 169 && b == 254 )) && return 0              # link-local, metadati del cloud
  (( a == 172 && b >= 16 && b <= 31 )) && return 0
  (( a == 192 && b == 168 )) && return 0
  (( a == 192 && b == 0 && c == 0 )) && return 0
  (( a == 198 && (b == 18 || b == 19) )) && return 0
  return 1
}
ip6_internal() { case "${1,,}" in ::|::1|fe[89ab]*|fc*|fd*|ff*|::ffff:*|64:ff9b:*|2001:db8:*) return 0 ;; esac; return 1; }
ssh_rules() { # $1 = 4 o 6
  local chain="ufw-before-output"; [[ "$1" == 6 ]] && chain="ufw6-before-output"
  sed 's/[[:space:]]*#.*$//' "$SSH_HOSTS" | while read -r entry; do
    [[ -z "$entry" ]] && continue
    local host="${entry%%:*}" port="22" priv=0
    [[ "$entry" == *:* ]] && port="${entry##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    grep -qxF "$(canon "$entry")" "$SSH_PRIVATE" && priv=1
    # Un nome che non si risolve si salta (con un avviso), senza fermare il resto.
    { getent "ahostsv$1" "$host" || echo "Non risolvo $host: lo salto." >&2; } | awk '{print $1}' | sort -u | while read -r ip; do
      [[ "$1" == 4 && "$ip" == *:* ]] && continue
      [[ "$1" == 6 && "$ip" != *:* ]] && continue
      [[ "$1" == 6 && "${ip,,}" == ::ffff:* ]] && continue   # IPv4 travestito da IPv6: già nelle regole IPv4
      if [[ $priv == 0 ]] && { { [[ "$1" == 4 ]] && ip4_internal "$ip"; } || { [[ "$1" == 6 ]] && ip6_internal "$ip"; }; }; then
        echo "Salto $entry → $ip: indirizzo interno non consentito da root (ssh-hosts.sh add $(canon "$entry") --privato)." >&2
        continue
      fi
      echo "-A $chain -m owner --uid-owner $UID_NUM -p tcp -d $ip --dport $port -j ACCEPT"
    done
  done
}
for f in /etc/ufw/before.rules /etc/ufw/before6.rules; do
  strip_block "$f"
  chain="ufw-before-output"; v=4; [[ "$f" == *before6.rules ]] && { chain="ufw6-before-output"; v=6; }
  rule="$(ssh_rules $v)"$'\n'"-A $chain -m owner --uid-owner $UID_NUM -j REJECT"
  rule="${rule#$'\n'}"
  # Il blocco va prima dell'ultimo COMMIT (tabella filter), dopo le regole lo/ESTABLISHED di ufw.
  # Le regole passano dall'ambiente (più righe: con -v awk non accetta gli a capo).
  RULES="$rule" awk -v b="$BEGIN" -v e="$END" '
    { lines[NR] = $0 } /^COMMIT$/ { last = NR }
    END { for (i = 1; i <= NR; i++) { if (i == last) { print b; print ENVIRON["RULES"]; print e } print lines[i] } }
  ' "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"
done
ufw reload >/dev/null
# Le regole devono esserci davvero, non solo nei file.
if ! iptables -S ufw-before-output 2>/dev/null | grep -q -- "--uid-owner $UID_NUM -j REJECT"; then
  echo "Le regole sono nei file di ufw ma non risultano attive (iptables -S ufw-before-output): controlla ufw status." >&2
  exit 1
fi
if [[ "$MODE" == "--rules-only" ]]; then echo "Regole del firewall riapplicate."; exit 0; fi

# 3. Proxy per le shell dell'utente (git, gh, pnpm, corepack, Claude Code).
SHELL_BLOCK="export HTTPS_PROXY=$PROXY HTTP_PROXY=$PROXY https_proxy=$PROXY http_proxy=$PROXY
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export NODE_USE_ENV_PROXY=1"
for f in "$HOME_DIR/.profile" "$HOME_DIR/.bashrc"; do user_block "$f" "$SHELL_BLOCK"; done

# 4. Proxy anche per il servizio Ciccio (le sessioni Claude ereditano l'ambiente), se ciccio.env c'è già.
ENV_BLOCK="HTTPS_PROXY=$PROXY
HTTP_PROXY=$PROXY
https_proxy=$PROXY
http_proxy=$PROXY
NO_PROXY=localhost,127.0.0.1,::1
no_proxy=localhost,127.0.0.1,::1
NODE_USE_ENV_PROXY=1"
user_block "$HOME_DIR/.config/ciccio.env" "$ENV_BLOCK" 1
restart_ciccio

echo "Firewall in uscita attivo per $USER_NAME (uid $UID_NUM). Domini consentiti: /etc/tinyproxy/ciccio-allow"
