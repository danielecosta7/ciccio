#!/usr/bin/env bash
# Domini nuovi nel proxy in uscita su richiesta degli agenti (strumento consenti_dominio).
#
# Mette l'helper root /usr/local/sbin/ciccio-egress-allow (da deploy/ciccio-egress-allow.sh) e una riga in
# /etc/sudoers.d/ciccio-egress che consente all'utente di Ciccio solo quel comando, senza password.
# Ogni dominio lo approva comunque l'utente in Ciccio; l'helper accetta solo nomi host semplici.
#
# Uso (come root, dalla copia di root /usr/local/lib/ciccio che mette setup.sh):
#   bash egress-helper.sh [utente]            installa o aggiorna l'helper
#   bash egress-helper.sh [utente] --remove   toglie helper e regola sudo
set -euo pipefail

# Utente di Ciccio: l'argomento, altrimenti /etc/ciccio/user (setup.sh), altrimenti il proprietario del repo.
USER_NAME=""; MODE=apply
for a in "$@"; do case "$a" in --*) MODE="$a" ;; *) USER_NAME="$a" ;; esac; done
if [[ -z "$USER_NAME" ]]; then
  if [[ -s /etc/ciccio/user ]]; then USER_NAME="$(head -1 /etc/ciccio/user)"
  else USER_NAME="$(stat -c %U "$(cd "$(dirname "$0")/.." && pwd)")"; fi
fi
HELPER=/usr/local/sbin/ciccio-egress-allow
SUDOERS=/etc/sudoers.d/ciccio-egress

[[ $EUID -eq 0 ]] || { echo "Da eseguire come root." >&2; exit 1; }
[[ "$USER_NAME" != root ]] || { echo "L'utente di Ciccio non può essere root (passalo come argomento)." >&2; exit 1; }
id -u "$USER_NAME" >/dev/null

if [[ "$MODE" == --remove ]]; then
  rm -f "$SUDOERS" "$HELPER"
  echo "Helper e regola sudo tolti: gli agenti non possono più chiedere domini. I domini già aggiunti restano in /etc/ciccio/egress-extra."
  exit 0
fi
[[ "$MODE" == apply ]] || { echo "Opzione sconosciuta: $MODE" >&2; exit 1; }

mkdir -p /etc/ciccio
[[ -s /etc/ciccio/user ]] || { echo "$USER_NAME" > /etc/ciccio/user; chmod 644 /etc/ciccio/user; }
install -o root -g root -m 755 "$(dirname "$0")/ciccio-egress-allow.sh" "$HELPER"
mkdir -p /etc/ciccio && touch /etc/ciccio/egress-extra && chmod 644 /etc/ciccio/egress-extra
[[ -f /etc/tinyproxy/ciccio-allow-base ]] || cp /etc/tinyproxy/ciccio-allow /etc/tinyproxy/ciccio-allow-base
touch /var/log/ciccio-egress.log && chown root:adm /var/log/ciccio-egress.log && chmod 640 /var/log/ciccio-egress.log
tmp="$(mktemp)"
cat > "$tmp" <<EOF
# Ciccio: l'utente $USER_NAME può solo lanciare l'helper che aggiunge o toglie un dominio dal proxy (deploy/egress-helper.sh).
$USER_NAME ALL=(root) NOPASSWD: $HELPER
EOF
# Una regola sudo sbagliata bloccherebbe sudo per tutti: prima si controlla.
visudo -cqf "$tmp"
install -o root -g root -m 440 "$tmp" "$SUDOERS"
rm -f "$tmp"
echo "Helper attivo: $HELPER, regola in $SUDOERS. Domini aggiunti: /etc/ciccio/egress-extra. Registro: /var/log/ciccio-egress.log."
