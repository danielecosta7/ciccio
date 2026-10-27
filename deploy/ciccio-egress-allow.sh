#!/usr/bin/env bash
# Helper root di Ciccio: aggiunge o toglie UN dominio dall'elenco del proxy in uscita (tinyproxy), dopo che
# l'utente l'ha approvato in Ciccio. Installato in /usr/local/sbin/ciccio-egress-allow da deploy/egress-helper.sh;
# l'utente di Ciccio lo lancia con sudo (sudoers limitato a questo file). Fa solo questo:
# - il dominio deve essere un nome host semplice (niente IP, porte, percorsi, caratteri jolly, nomi locali);
# - i domini aggiunti stanno in /etc/ciccio/egress-extra, separati da quelli fissi di deploy/egress-firewall.sh
#   (/etc/tinyproxy/ciccio-allow-base): l'elenco del proxy è la somma dei due, rifatta a ogni modifica;
# - registra chi, cosa e quando in /var/log/ciccio-egress.log.
# Uso: ciccio-egress-allow add <dominio> <0|1: anche i sottodomini> [richiesta]
#      ciccio-egress-allow remove <dominio>
# Ultima riga dell'output: «OK <dominio>», «GIA <dominio>», «TOLTO <dominio>» oppure «ERRORE <motivo>».
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
umask 022
LOG=/var/log/ciccio-egress.log
BASE=/etc/tinyproxy/ciccio-allow-base
EXTRA=/etc/ciccio/egress-extra
FILTER=/etc/tinyproxy/ciccio-allow

ACTION="${1:-}"
DOMAIN="$(printf '%s' "${2:-}" | tr 'A-Z' 'a-z')"
SUBS="${3:-0}"
WHO="$(printf '%s' "${4:-}" | tr -cd 'A-Za-z0-9 ._:/@()+-' | cut -c1-120)"
CLEAN="$(printf '%s' "$DOMAIN" | tr -cd 'a-z0-9.-' | cut -c1-253)"

log() { printf '%s\t%s\t%s\t%s\t%s\n' "$(date -Is)" "${SUDO_USER:-$(id -un)}" "${CLEAN:-?}" "$1" "${WHO:-—}${2:+ · $2}" >> "$LOG"; }
fail() { log rifiutato "$1"; echo "ERRORE $1"; exit 1; }

[[ $EUID -eq 0 ]] || { echo "ERRORE serve root (sudo)"; exit 1; }
[[ "$ACTION" == add || "$ACTION" == remove ]] || fail "uso: ciccio-egress-allow add|remove <dominio> [0|1] [richiesta]"
# Nome host: etichette di lettere, cifre e trattini, almeno un punto, dominio di primo livello di sole lettere.
[[ ${#DOMAIN} -le 253 && "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
  || fail "dominio non valido: serve un nome host semplice (es. export-download.canva.com), senza IP, porte, percorsi o caratteri jolly"
[[ "$DOMAIN" =~ (^|\.)(localhost|local|internal|lan|home|arpa|corp|intranet|ts\.net)$ ]] && fail "nomi locali o della rete interna non si aprono dal proxy"
[[ "$SUBS" == 0 || "$SUBS" == 1 ]] || fail "terzo argomento: 0 (solo il dominio) o 1 (anche i sottodomini)"
# I sottodomini di un intero dominio di primo o secondo livello pubblico (com, co.uk…) no.
if [[ "$SUBS" == 1 ]]; then
  [[ "$DOMAIN" == *.* && ! "$DOMAIN" =~ ^(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$ ]] || fail "i sottodomini si aprono solo per un dominio preciso, non per $DOMAIN"
fi

ESC="${DOMAIN//./\\.}"
PATTERN="^$ESC\$"; [[ "$SUBS" == 1 ]] && PATTERN="(^|\\.)$ESC\$"

exec 9>/run/ciccio-egress.lock
flock -w 30 9 || fail "un'altra modifica è in corso"
mkdir -p /etc/ciccio && touch "$EXTRA" && chmod 644 "$EXTRA"
# Prima volta: l'elenco fisso è quello attuale del proxy.
[[ -f "$BASE" ]] || cp "$FILTER" "$BASE"

compose() {
  { cat "$BASE"; awk -F'\t' '!/^#/ && NF { print $1 }' "$EXTRA"; } > "$FILTER.tmp" && mv "$FILTER.tmp" "$FILTER"
  chmod 644 "$FILTER"
  systemctl reload tinyproxy 2>/dev/null || systemctl restart tinyproxy
}

if [[ "$ACTION" == remove ]]; then
  grep -q -P "^[^\t]+\t\Q$DOMAIN\E\t" "$EXTRA" || fail "$DOMAIN non è tra i domini aggiunti (quelli fissi si cambiano in deploy/egress-firewall.sh)"
  grep -v -P "^[^\t]+\t\Q$DOMAIN\E\t" "$EXTRA" > "$EXTRA.tmp"; mv "$EXTRA.tmp" "$EXTRA"; chmod 644 "$EXTRA"
  compose
  log tolto
  echo "TOLTO $DOMAIN"
  exit 0
fi

# Già consentito (dall'elenco fisso o da uno aggiunto): niente da fare.
while IFS= read -r p; do
  [[ -z "$p" || "$p" == \#* ]] && continue
  if [[ "$DOMAIN" =~ $p ]]; then log gia; echo "GIA $DOMAIN"; exit 0; fi
done < <(cat "$BASE"; awk -F'\t' '!/^#/ && NF { print $1 }' "$EXTRA")

printf '%s\t%s\t%s\t%s\n' "$PATTERN" "$DOMAIN" "${WHO:-—}" "$(date -Is)" >> "$EXTRA"
compose
log aggiunto "$PATTERN"
echo "OK $DOMAIN"
