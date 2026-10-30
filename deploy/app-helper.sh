#!/usr/bin/env bash
# Installazione di programmi scaricati su richiesta degli agenti (strumento installa_da_url): AppImage e archivi tar.
#
# Mette l'helper root /usr/local/sbin/ciccio-app-install (da deploy/ciccio-app-install.sh) e una riga in
# /etc/sudoers.d/ciccio-app che consente all'utente di Ciccio solo quel comando, senza password.
# Ogni installazione la approva comunque l'utente in Ciccio, che gli mostra indirizzo, nome e comandi.
# Serve anche squashfs-tools per le AppImage (un pacchetto ufficiale di Ubuntu: lo si chiede con installa_programma).
#
# Uso (come root, dalla copia di root /usr/local/lib/ciccio che mette setup.sh):
#   bash app-helper.sh [utente]            installa o aggiorna l'helper
#   bash app-helper.sh [utente] --remove   toglie helper e regola sudo (i programmi in /opt/ciccio-app restano)
set -euo pipefail

# Utente di Ciccio: l'argomento, altrimenti /etc/ciccio/user (setup.sh), altrimenti il proprietario del repo.
USER_NAME=""; MODE=apply
for a in "$@"; do case "$a" in --*) MODE="$a" ;; *) USER_NAME="$a" ;; esac; done
if [[ -z "$USER_NAME" ]]; then
  if [[ -s /etc/ciccio/user ]]; then USER_NAME="$(head -1 /etc/ciccio/user)"
  else USER_NAME="$(stat -c %U "$(cd "$(dirname "$0")/.." && pwd)")"; fi
fi
HELPER=/usr/local/sbin/ciccio-app-install
SUDOERS=/etc/sudoers.d/ciccio-app

[[ $EUID -eq 0 ]] || { echo "Da eseguire come root." >&2; exit 1; }
[[ "$USER_NAME" != root ]] || { echo "L'utente di Ciccio non può essere root (passalo come argomento)." >&2; exit 1; }
id -u "$USER_NAME" >/dev/null

if [[ "$MODE" == --remove ]]; then
  rm -f "$SUDOERS" "$HELPER"
  echo "Helper e regola sudo tolti: gli agenti non possono più installare programmi scaricati. I programmi in /opt/ciccio-app restano; registro in /var/log/ciccio-app.log."
  exit 0
fi
[[ "$MODE" == apply ]] || { echo "Opzione sconosciuta: $MODE" >&2; exit 1; }

mkdir -p /etc/ciccio /opt/ciccio-app
[[ -s /etc/ciccio/user ]] || { echo "$USER_NAME" > /etc/ciccio/user; chmod 644 /etc/ciccio/user; }
chmod 755 /opt/ciccio-app
install -o root -g root -m 755 "$(dirname "$0")/ciccio-app-install.sh" "$HELPER"
touch /var/log/ciccio-app.log && chown root:adm /var/log/ciccio-app.log && chmod 640 /var/log/ciccio-app.log
tmp="$(mktemp)"
cat > "$tmp" <<EOF
# Ciccio: l'utente $USER_NAME può solo lanciare l'helper che installa in /opt/ciccio-app un programma scaricato (deploy/app-helper.sh).
$USER_NAME ALL=(root) NOPASSWD: $HELPER
EOF
# Una regola sudo sbagliata bloccherebbe sudo per tutti: prima si controlla.
visudo -cqf "$tmp"
install -o root -g root -m 440 "$tmp" "$SUDOERS"
rm -f "$tmp"
echo "Helper attivo: $HELPER, regola in $SUDOERS. Programmi in /opt/ciccio-app, registro: /var/log/ciccio-app.log. Per toglierlo: --remove."
