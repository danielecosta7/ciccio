#!/usr/bin/env bash
# xvfb-run per gli agenti di Ciccio: c'è già uno schermo virtuale condiviso (ciccio-display, in DISPLAY),
# e nella sandbox quello vero non parte (/tmp in sola lettura). Si saltano le opzioni di xvfb-run e si lancia
# il comando su quello schermo. Senza schermo condiviso (DISPLAY vuoto o spento) si passa all'xvfb-run vero.
# Installato da deploy/install.sh in ~/.local/bin, che nel PATH viene prima di /usr/bin.
set -euo pipefail
n="${DISPLAY:-}"; n="${n#:}"; n="${n%%.*}"
if [[ -z "${DISPLAY:-}" || ! -S "/tmp/.X11-unix/X${n}" ]]; then exec /usr/bin/xvfb-run "$@"; fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift; break ;;
    -a|--auto-servernum|-l|--listen-tcp|-h|--help) shift ;;
    -n|-s|-e|-f|-p|-w|--server-num|--server-args|--error-file|--auth-file|--xauth-protocol|--wait) shift 2 ;;
    --server-num=*|--server-args=*|--error-file=*|--auth-file=*|--xauth-protocol=*|--wait=*) shift ;;
    *) break ;;
  esac
done
exec "$@"
