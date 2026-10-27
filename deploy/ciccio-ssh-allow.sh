#!/usr/bin/env bash
# Helper root di Ciccio: aggiunge, toglie o elenca i server raggiungibili in SSH dagli agenti (/etc/ciccio/ssh-hosts)
# e riapplica le regole del firewall in uscita. Installato in /usr/local/sbin/ciccio-ssh-allow da deploy/ssh-helper.sh;
# l'utente di Ciccio lo lancia con sudo (sudoers limitato a questo file) dopo che il proprietario l'ha approvato.
# Rifà tutti i controlli da sé, senza fidarsi di Ciccio:
# - host: nome host semplice (lettere, cifre, trattini, almeno un punto) o IPv4; porta 1-65535, 22 se manca;
#   niente IPv6 scritti a mano (si usa il nome), utenti, percorsi, opzioni;
# - niente indirizzi interni: loopback, reti private, link-local (169.254.x.x, i metadati del cloud), CGNAT e
#   tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48), multicast; un nome si risolve e ogni suo indirizzo deve essere
#   pubblico; nomi locali (.local, .internal, .ts.net…) no;
# - un server interno lo aggiunge solo root in persona con --privato (mai l'utente di Ciccio via sudo): finisce
#   anche in /etc/ciccio/ssh-hosts-private, che il firewall rispetta anche se l'indirizzo cambia;
# - registra chi, cosa e quando in /var/log/ciccio-ssh.log.
# Uso: ciccio-ssh-allow add <host[:porta]> [--privato]
#      ciccio-ssh-allow remove <host[:porta]>
#      ciccio-ssh-allow list
# Uscita 0: fatto (stdout «OK <voce>», «GIA <voce>», «TOLTO <voce>», o l'elenco una voce per riga).
# Uscita 1: rifiutato o non riuscito, con il motivo in una riga su stderr.
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 022
LOG=/var/log/ciccio-ssh.log
FILE=/etc/ciccio/ssh-hosts
PRIVATE=/etc/ciccio/ssh-hosts-private
FIREWALL=/usr/local/lib/ciccio/egress-firewall.sh

ACTION="${1:-}"; RAW="${2:-}"; FLAG="${3:-}"
SHOWN="$(printf '%s' "$RAW" | tr -cd 'A-Za-z0-9.:-' | cut -c1-260)"
log() { printf '%s\t%s\t%s\t%s\t%s\n' "$(date -Is)" "${SUDO_USER:-$(id -un)}" "${SHOWN:-?}" "$1" "${2:-}" >> "$LOG" 2>/dev/null; }
fail() { log rifiutato "$1"; printf '%s\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || { echo "serve root (sudo)" >&2; exit 1; }
CICCIO_USER="$(head -1 /etc/ciccio/user 2>/dev/null || true)"
[[ -n "$CICCIO_USER" ]] || CICCIO_USER="${SUDO_USER:-}"
mkdir -p /etc/ciccio
[[ -f "$FILE" ]] || printf '# Server raggiungibili in SSH dagli agenti di Ciccio: host o host:porta, uno per riga.\n' > "$FILE"
chmod 644 "$FILE"

entries() { sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//' "$1" 2>/dev/null | grep -v '^$' || true; }
canon() { local e="${1,,}"; printf '%s' "${e%:22}"; }

if [[ "$ACTION" == list && $# -eq 1 ]]; then entries "$FILE"; exit 0; fi
[[ ( "$ACTION" == add && ( $# -eq 2 || $# -eq 3 ) ) || ( "$ACTION" == remove && $# -eq 2 ) ]] \
  || fail "uso: ciccio-ssh-allow add|remove <host[:porta]> | list"
[[ $# -lt 3 || "$FLAG" == --privato ]] || fail "opzione sconosciuta: $FLAG"

# Nome o IPv4, con :porta facoltativa.
if [[ "$RAW" == *:* ]]; then HOST="${RAW%:*}"; PORT="${RAW##*:}"; else HOST="$RAW"; PORT=22; fi
HOST="${HOST,,}"
[[ "$HOST" == *:* ]] && fail "IPv6 scritto a mano non va: usa il nome del server"
[[ "$PORT" =~ ^[1-9][0-9]{0,4}$ ]] && (( PORT <= 65535 )) || fail "porta non valida: $PORT (1-65535)"
OCT='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
IS_IP=0; [[ "$HOST" =~ ^$OCT(\.$OCT){3}$ ]] && IS_IP=1
if [[ $IS_IP == 0 ]]; then
  [[ ${#HOST} -le 253 && "$HOST" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
    || fail "host non valido: serve un nome (es. server.example.com) o un IPv4, con :porta facoltativa"
  # Niente numeri travestiti da nome (010.0.0.1, 2130706433): l'ultima parte di un nome ha almeno una lettera.
  [[ "${HOST##*.}" =~ [a-z] ]] || fail "host non valido: $HOST non è né un IPv4 scritto per bene né un nome"
fi
ENTRY="$HOST"; (( PORT != 22 )) && ENTRY="$HOST:$PORT"

exec 9>/run/ciccio-ssh.lock
flock -w 30 9 || fail "un'altra modifica è in corso"

# Prima volta: i server già in elenco li aveva messi root (prima non c'era l'helper), quindi valgono anche se interni.
if [[ ! -f "$PRIVATE" ]]; then
  { echo "# Server SSH che root ha consentito anche se interni (reti private, tailnet). Uno per riga, come in ssh-hosts."
    entries "$FILE" | while read -r e; do canon "$e"; echo; done; } > "$PRIVATE"
fi
chmod 644 "$PRIVATE"

# Riapplica le regole se il firewall in uscita è attivo; se non riesce, rimette i file com'erano.
reapply() {
  grep -q '^# BEGIN ciccio-egress$' /etc/ufw/before.rules 2>/dev/null || return 0
  [[ -f "$FIREWALL" ]] || { restore; fail "manca la copia di root $FIREWALL: come root, setup.sh --step copia-root"; }
  [[ -n "$CICCIO_USER" ]] || { restore; fail "non so chi è l'utente di Ciccio (/etc/ciccio/user)"; }
  local out
  if ! out="$(bash "$FIREWALL" "$CICCIO_USER" --rules-only 2>&1)"; then
    restore; fail "regole del firewall non riapplicate: $(tail -1 <<<"$out" | cut -c1-200)"
  fi
}
BACKUP="$(mktemp -d)"; trap 'rm -rf "$BACKUP"' EXIT
cp -p "$FILE" "$BACKUP/hosts"; cp -p "$PRIVATE" "$BACKUP/private"
restore() { cat "$BACKUP/hosts" > "$FILE"; cat "$BACKUP/private" > "$PRIVATE"; }
# Scrive un elenco senza la voce $2 (e, con $3, aggiungendola in fondo).
rewrite() {
  local f="$1" drop="$2" add="${3:-}"
  { grep -v '^[[:space:]]*$' "$f" | while IFS= read -r l; do
      v="$(sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//' <<<"$l")"
      [[ -n "$v" && "$(canon "$v")" == "$drop" ]] || printf '%s\n' "$l"
    done
    [[ -z "$add" ]] || printf '%s\n' "$add"; } > "$f.tmp" && chmod 644 "$f.tmp" && mv "$f.tmp" "$f"
}

if [[ "$ACTION" == remove ]]; then
  entries "$FILE" | while read -r e; do [[ "$(canon "$e")" == "$ENTRY" ]] && exit 7; done
  [[ $? -eq 7 ]] || fail "$ENTRY non è tra i server SSH consentiti"
  rewrite "$FILE" "$ENTRY"; rewrite "$PRIVATE" "$ENTRY"
  reapply
  log tolto
  echo "TOLTO $ENTRY"
  exit 0
fi

# --privato solo da root in persona (o da un amministratore con sudo), mai dall'utente di Ciccio.
PRIV=0
if [[ "$FLAG" == --privato ]]; then
  [[ -n "${SUDO_USER:-}" && "$SUDO_USER" == "$CICCIO_USER" ]] && fail "i server interni li aggiunge solo root (ssh-hosts.sh add $ENTRY --privato)"
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] && ! id -nG "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel'; then
    fail "--privato è solo per root o per un amministratore"
  fi
  PRIV=1
fi

if [[ $PRIV == 0 ]]; then
  [[ $IS_IP == 1 || "$HOST" == *.* ]] || fail "serve un nome completo (es. server.example.com): i nomi brevi sono della rete interna"
  [[ "$HOST" =~ (^|\.)(localhost|local|localdomain|internal|lan|home|arpa|corp|intranet|private|test|invalid|ts\.net)$ ]] \
    && fail "$HOST è un nome locale o della rete interna: lo aggiunge solo root (ssh-hosts.sh add $ENTRY --privato)"
  [[ $IS_IP == 1 ]] || [[ "$HOST" =~ \.[a-z]{2,63}$ ]] || fail "host non valido: il dominio di primo livello deve essere di sole lettere"
fi

# Indirizzi interni (uguale in egress-firewall.sh): 0 = interno.
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

IPS="$(timeout 15 getent ahosts "$HOST" | awk '{print $1}' | sort -u)"
[[ -n "$IPS" ]] || fail "$HOST non si risolve"
if [[ $PRIV == 0 ]]; then
  while read -r ip; do
    if { [[ "$ip" == *:* ]] && ip6_internal "$ip"; } || { [[ "$ip" != *:* ]] && ip4_internal "$ip"; }; then
      fail "$HOST porta a un indirizzo interno ($ip): i server interni li aggiunge solo root (ssh-hosts.sh add $ENTRY --privato)"
    fi
  done <<<"$IPS"
fi

already=0
entries "$FILE" | while read -r e; do [[ "$(canon "$e")" == "$ENTRY" ]] && exit 7; done
[[ $? -eq 7 ]] && already=1
inpriv=0; grep -qxF "$ENTRY" "$PRIVATE" && inpriv=1
if [[ $already == 1 && ( $PRIV == 0 || $inpriv == 1 ) ]]; then log gia; echo "GIA $ENTRY"; exit 0; fi

[[ $already == 1 ]] || rewrite "$FILE" "$ENTRY" "$ENTRY"
[[ $PRIV == 0 || $inpriv == 1 ]] || rewrite "$PRIVATE" "$ENTRY" "$ENTRY"
reapply
log aggiunto "$( [[ $PRIV == 1 ]] && echo privato || echo pubblico) $(tr '\n' ' ' <<<"$IPS")"
echo "OK $ENTRY"
