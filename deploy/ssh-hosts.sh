#!/usr/bin/env bash
# Server raggiungibili in SSH dagli agenti di Ciccio (chiavi SSH di 1Password via companion), da root.
# Passa da ciccio-ssh-allow, lo stesso helper delle Impostazioni: stessi controlli, stesso registro, e dopo ogni
# modifica riapplica il firewall in uscita. Da root si possono aggiungere anche server interni (rete privata,
# tailnet) con --privato.
#
# Uso (come root):  bash ssh-hosts.sh list
#                   bash ssh-hosts.sh add host[:porta] [--privato]
#                   bash ssh-hosts.sh remove host[:porta]
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Da eseguire come root." >&2; exit 1; }
# Mai la copia del repo dell'utente: quella la può modificare lui.
H=/usr/local/sbin/ciccio-ssh-allow
[[ -f "$H" ]] || H=/usr/local/lib/ciccio/ciccio-ssh-allow.sh
[[ -f "$H" ]] || { echo "Manca la copia di root di ciccio-ssh-allow: sudo bash deploy/setup.sh --step copia-root" >&2; exit 1; }
cmd="${1:-list}"
case "$cmd" in
  list) out="$(bash "$H" list)"; echo "${out:-(nessun server)}" ;;
  add|remove)
    bash "$H" "$@"
    echo "Server SSH consentiti:"; out="$(bash "$H" list)"; echo "${out:-(nessuno)}" ;;
  *) echo "Uso: $0 list | add host[:porta] [--privato] | remove host[:porta]" >&2; exit 1 ;;
esac
