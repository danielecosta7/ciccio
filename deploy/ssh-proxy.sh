#!/bin/sh
# ProxyCommand di ssh dentro la sandbox degli agenti (install.sh lo copia in ~/.local/bin/ciccio-ssh-proxy).
# La sandbox non ha rete diretta: ssh, scp e rsync passano dal suo proxy (HTTP CONNECT, lo stesso che usa
# git con GIT_SSH_COMMAND), che poi decide se l'host è consentito. Uso: ciccio-ssh-proxy %h %p
#
# Prima, se la chat ha il socket del ponte SSH (CICCIO_SSH_BRIDGE, server/src/sshBridge.ts), gli si chiede se un PC
# con il companion fa da ponte verso %h:%p (server della rete dell'ufficio): sì → la connessione passa da lì
# (ciccio-ssh-bridge.cjs); nessun ponte → come prima; errore → si ferma con il motivo.
b="${CICCIO_SSH_BRIDGE:-}"
if [ -n "$b" ] && [ -S "$b" ] && command -v node >/dev/null 2>&1; then
  node "$(dirname "$0")/ciccio-ssh-bridge.cjs" "$1" "$2"
  rc=$?
  [ "$rc" -eq 3 ] || exit "$rc"
fi
u="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
[ -n "$u" ] || { echo "ciccio-ssh-proxy: nessun proxy della sandbox (HTTPS_PROXY vuoto)" >&2; exit 1; }
u="${u#*://}"; u="${u%/}"
case "$u" in *@*) auth=",proxyauth=${u%@*}"; hp="${u##*@}" ;; *) auth=""; hp="$u" ;; esac
exec socat - "PROXY:${hp%:*}:$1:$2,proxyport=${hp##*:}$auth"
