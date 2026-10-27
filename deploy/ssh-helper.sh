#!/usr/bin/env bash
# Server SSH degli agenti dalle Impostazioni di Ciccio, senza root a mano.
#
# Mette l'helper root /usr/local/sbin/ciccio-ssh-allow (da deploy/ciccio-ssh-allow.sh) e una riga in
# /etc/sudoers.d/ciccio-ssh che consente all'utente di Ciccio solo quel comando, senza password.
# Ogni server lo approva il proprietario in Ciccio; l'helper accetta solo server pubblici (gli interni li aggiunge
# root con ssh-hosts.sh add host --privato) e riapplica il firewall in uscita.
#
# Uso (come root, dalla copia di root /usr/local/lib/ciccio):
#   bash ssh-helper.sh [utente]            installa o aggiorna l'helper
#   bash ssh-helper.sh [utente] --remove   toglie helper e regola sudo (l'elenco /etc/ciccio/ssh-hosts resta)
set -euo pipefail

USER_NAME=""; MODE=apply
for a in "$@"; do case "$a" in --*) MODE="$a" ;; *) USER_NAME="$a" ;; esac; done
if [[ -z "$USER_NAME" ]]; then
  if [[ -s /etc/ciccio/user ]]; then USER_NAME="$(head -1 /etc/ciccio/user)"
  else USER_NAME="$(stat -c %U "$(cd "$(dirname "$0")/.." && pwd)")"; fi
fi
HELPER=/usr/local/sbin/ciccio-ssh-allow
SUDOERS=/etc/sudoers.d/ciccio-ssh

[[ $EUID -eq 0 ]] || { echo "Da eseguire come root." >&2; exit 1; }
[[ "$USER_NAME" != root ]] || { echo "L'utente di Ciccio non può essere root (passalo come argomento)." >&2; exit 1; }
id -u "$USER_NAME" >/dev/null

if [[ "$MODE" == --remove ]]; then
  rm -f "$SUDOERS" "$HELPER"
  echo "Helper e regola sudo tolti: i server SSH si cambiano solo da root (ssh-hosts.sh). L'elenco resta in /etc/ciccio/ssh-hosts."
  exit 0
fi
[[ "$MODE" == apply ]] || { echo "Opzione sconosciuta: $MODE" >&2; exit 1; }

mkdir -p /etc/ciccio
[[ -s /etc/ciccio/user ]] || { echo "$USER_NAME" > /etc/ciccio/user; chmod 644 /etc/ciccio/user; }
install -o root -g root -m 755 "$(dirname "$0")/ciccio-ssh-allow.sh" "$HELPER"
touch /var/log/ciccio-ssh.log && chown root:adm /var/log/ciccio-ssh.log && chmod 640 /var/log/ciccio-ssh.log
tmp="$(mktemp)"
cat > "$tmp" <<EOF
# Ciccio: l'utente $USER_NAME può solo lanciare l'helper che aggiunge o toglie un server SSH degli agenti (deploy/ssh-helper.sh).
$USER_NAME ALL=(root) NOPASSWD: $HELPER
EOF
# Una regola sudo sbagliata bloccherebbe sudo per tutti: prima si controlla.
visudo -cqf "$tmp"
install -o root -g root -m 440 "$tmp" "$SUDOERS"
rm -f "$tmp"
echo "Helper attivo: $HELPER, regola in $SUDOERS. Elenco: /etc/ciccio/ssh-hosts. Registro: /var/log/ciccio-ssh.log. Per toglierlo: --remove."
