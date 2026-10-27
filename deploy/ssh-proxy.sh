#!/bin/sh
# ProxyCommand di ssh dentro la sandbox degli agenti (install.sh lo copia in ~/.local/bin/ciccio-ssh-proxy).
# La sandbox non ha rete diretta: ssh, scp e rsync passano dal suo proxy (HTTP CONNECT, lo stesso che usa
# git con GIT_SSH_COMMAND), che poi decide se l'host è consentito. Uso: ciccio-ssh-proxy %h %p
u="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
[ -n "$u" ] || { echo "ciccio-ssh-proxy: nessun proxy della sandbox (HTTPS_PROXY vuoto)" >&2; exit 1; }
u="${u#*://}"; u="${u%/}"
case "$u" in *@*) auth=",proxyauth=${u%@*}"; hp="${u##*@}" ;; *) auth=""; hp="$u" ;; esac
exec socat - "PROXY:${hp%:*}:$1:$2,proxyport=${hp##*:}$auth"
