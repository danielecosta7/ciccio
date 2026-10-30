#!/usr/bin/env bash
# Aggiorna e (ri)avvia Ciccio sul server. Da eseguire come l'utente che lo ospita, dentro ~/ciccio.
# La prima installazione la guida setup.sh (come root); da lì in poi si aggiorna con questo, senza root.
#
# Uso: bash deploy/install.sh        aggiorna (git pull), compila e riavvia; la prima volta scrive ~/.config/ciccio.env
#      bash deploy/install.sh code   un codice di attivazione nuovo: primo accesso, o un dispositivo da aggiungere
#                                    quando non ne hai più uno collegato
#      bash deploy/install.sh env    scrive solo ~/.config/ciccio.env, commentato, se manca (lo usa setup.sh)
set -euo pipefail
CMD="${1:-install}"
[[ "$CMD" == install || "$CMD" == code || "$CMD" == env ]] || { echo "Uso: bash deploy/install.sh [code|env]" >&2; exit 1; }
cd "$HOME/ciccio"
# Node 24 dell'utente (~/.local/node), separato dal Node di sistema.
export PATH="$HOME/.local/node/bin:$PATH"
ENV_FILE="$HOME/.config/ciccio.env"
# Variabili del servizio, proxy di uscita compreso: senza, lanciato via ssh, pnpm non scarica le dipendenze nuove.
if [[ -f "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi
DATA_DIR="${CICCIO_DATA_DIR:-$HOME/.ciccio}"
API="http://${CICCIO_HOST:-127.0.0.1}:${CICCIO_PORT:-8787}/api"

# Chiamata a Ciccio con il token locale (CICCIO_DATA_DIR/local-token, che Ciccio riscrive a ogni avvio), diretta,
# senza il proxy di uscita (che rifiuta l'indirizzo interno). Il token passa da un file, non dalla riga di comando.
local_api() {
  local tok; tok=$(cat "$DATA_DIR/local-token" 2>/dev/null || true)
  curl -sf --noproxy '*' --max-time "${CURL_TIMEOUT:-5}" -H @<(printf 'X-Ciccio-Local: %s\n' "$tok") "$@"
}

# --- install.sh code: codice di attivazione nuovo ----------------------------------------------------------------
if [[ "$CMD" == code ]]; then
  [[ -s "$DATA_DIR/local-token" ]] || { echo "Ciccio non è avviato (manca $DATA_DIR/local-token): systemctl --user status ciccio" >&2; exit 1; }
  if out=$(CURL_TIMEOUT=10 local_api -X POST -H 'content-type: application/json' -d '{}' "$API/auth/device-code"); then
    printf '%s' "$out" | ORIGIN="${CICCIO_ORIGINS%%,*}" node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const r = JSON.parse(s);
        console.log(`Apri ${process.env.ORIGIN || "Ciccio"} e inserisci il codice di attivazione: ${r.code}`);
        console.log(`Vale ${r.minutes} minuti e una volta sola. Con il codice crei la passkey (Face ID, Touch ID, impronta o PIN).`);
      });'
    exit 0
  fi
  echo "Ciccio non ha dato il codice (è avviato? systemctl --user status ciccio)." >&2
  echo "Alla primissima installazione il codice è anche nel registro: journalctl --user -u ciccio | grep attivazione | tail -1" >&2
  exit 1
fi

# --- ciccio.env commentato, la prima volta -----------------------------------------------------------------------
write_env() {
  [[ -f "$ENV_FILE" ]] && return 0
  local origins="${CICCIO_ORIGINS:-}" owner ts_name tz_line
  if [[ -z "$origins" ]]; then
    # Nome https del server sulla tailnet (MagicDNS), es. ciccio.tail1234.ts.net.
    ts_name="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).Self?.DNSName??"").replace(/\.$/,""))}catch{}})')"
    if [[ -z "$ts_name" ]]; then echo "Non trovo il nome del server su Tailscale: attiva MagicDNS e HTTPS nella console di Tailscale (https://login.tailscale.com/admin/dns)." >&2; exit 1; fi
    origins="https://$ts_name"
  fi
  # Nome di chi usa Ciccio: CICCIO_OWNER_NAME passato a install.sh, altrimenti il nome completo dell'utente di sistema.
  owner="${CICCIO_OWNER_NAME:-$(getent passwd "$USER" | cut -d: -f5 | cut -d, -f1 | cut -d' ' -f1)}"
  owner="$(printf '%s' "${owner:-$USER}" | tr -d '"\\$`')"
  tz_line="# CICCIO_TZ=Europe/Rome"; [[ -n "${CICCIO_TZ:-}" ]] && tz_line="CICCIO_TZ=$CICCIO_TZ"
  mkdir -p "$HOME/.config"
  (umask 077; cat > "$ENV_FILE" <<EOF
# Configurazione di Ciccio: la leggono il servizio (systemd) e deploy/install.sh. Una variabile per riga, NOME=valore;
# le righe che iniziano con # sono commenti, quelle commentate qui sotto mostrano il valore di default.
# Dopo una modifica: systemctl --user restart ciccio. Elenco completo: server/src/config.ts.

# --- Obbligatorie ----------------------------------------------------------------------------------------------
# Il tuo nome: Ciccio e gli agenti ti chiamano così.
CICCIO_OWNER_NAME="$owner"
# Indirizzi https da cui apri Ciccio, separati da virgola; il primo è quello dei link (notifiche, companion).
# Di solito quello di Tailscale; un dominio pubblico (dietro Caddy) si aggiunge dopo una virgola.
CICCIO_ORIGINS=$origins
# Claude: niente chiave API. Ciccio usa il login di claude.ai di questo utente (setup.sh --step ciccio lo fa).

# --- Server ----------------------------------------------------------------------------------------------------
# Indirizzo e porta su cui ascolta Ciccio: 127.0.0.1, dalla tailnet ci arriva tailscale serve in https.
CICCIO_HOST=127.0.0.1
CICCIO_PORT=8787
# Cartella con un repo per progetto: ognuno diventa un agente.
CICCIO_PROJECTS_DIR=$HOME/projects
# Database e dati di Ciccio (gli agenti non la vedono).
CICCIO_DATA_DIR=$HOME/.ciccio
# Interfaccia web compilata (default: quella di questo repo, dist/web).
# CICCIO_WEB_DIR=
# Proxy di cui fidarsi per l'indirizzo vero del client (X-Forwarded-For): IP, reti o loopback, separati da virgola.
# CICCIO_TRUST_PROXY=loopback
# Codice sorgente di questo Ciccio (link nella pagina di accesso e nelle Impostazioni, AGPL-3.0). Se offri ad altri
# una versione modificata, metti qui l'indirizzo del tuo codice.
# CICCIO_SOURCE_URL=https://github.com/danielecosta7/ciccio

# --- Agenti e Ciccio -------------------------------------------------------------------------------------------
# Agenti al lavoro insieme; gli altri aspettano in coda.
# CICCIO_MAX_ACTIVE=5
# Modello degli agenti e di Ciccio.
# CICCIO_AGENT_MODEL=claude-opus-5-5
# CICCIO_MODEL=claude-opus-5-5
# Giorni senza attività dopo cui un progetto con lavoro aperto è «fermo».
# CICCIO_STALE_DAYS=7
# Ora in cui Ciccio prepara il riepilogo del giorno.
# CICCIO_RECAP_HOUR=5
# Fuso orario di orari, routine e riepilogo (nome IANA, es. Europe/Rome).
$tz_line

# --- Riavvii senza perdere lavoro (server/src/restart.ts) --------------------------------------------------------
# Secondi lasciati ai giri al lavoro quando il servizio si ferma.
# CICCIO_SHUTDOWN_GRACE_S=20
# Secondi di attesa all'avvio perché tornino i PC collegati prima.
# CICCIO_RESUME_PC_WAIT_S=30

# --- Voce (deploy/install-voice.sh) -----------------------------------------------------------------------------
# CICCIO_VOICE_URL=http://127.0.0.1:8791

# --- Solo per prove fuori da Linux, mai sul server: strumenti su misura senza sandbox ------------------------------
# CICCIO_TOOLS_NO_SANDBOX=1
EOF
  )
  chmod 600 "$ENV_FILE"
  echo "Scritto $ENV_FILE (commentato): controlla nome e indirizzi."
}
if [[ "$CMD" == env ]]; then write_env; exit 0; fi

# --- Controlli prima di toccare qualcosa -------------------------------------------------------------------------
# Tailscale è obbligatorio: Ciccio si raggiunge dalla tailnet (tailscale serve, https) e mai direttamente da internet.
if ! command -v tailscale >/dev/null || ! tailscale status >/dev/null 2>&1; then
  echo "Tailscale non è installato o non è collegato: come root, sudo bash deploy/setup.sh --step tailscale (o https://tailscale.com/download/linux), poi riprova." >&2
  exit 1
fi
# Indirizzi da cui si apre Ciccio: senza, la passkey non funziona e nessuno potrebbe entrare. Alla prima
# installazione li scrive più sotto insieme a ciccio.env.
if [[ -f "$ENV_FILE" && -z "${CICCIO_ORIGINS:-}" ]]; then
  echo "Manca CICCIO_ORIGINS in ~/.config/ciccio.env (es. CICCIO_ORIGINS=https://ciccio.tail1234.ts.net). Aggiungilo e riprova." >&2
  exit 1
fi
# Il nome con cui Ciccio e gli agenti chiamano chi li usa.
if [[ -f "$ENV_FILE" && -z "${CICCIO_OWNER_NAME:-}" ]]; then
  echo "Manca CICCIO_OWNER_NAME in ~/.config/ciccio.env (il tuo nome, es. CICCIO_OWNER_NAME=Giulia). Aggiungilo e riprova." >&2
  exit 1
fi
# Programmi: Node 24 con corepack, git, e per la sandbox degli agenti bubblewrap e socat.
missing() { echo "Manca $1. $2" >&2; exit 1; }
command -v node >/dev/null || missing "Node" "Node 24 va in ~/.local/node: come root, sudo bash deploy/setup.sh --step node"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 24 )) || missing "Node 24 (c'è $(node -v))" "Come root: sudo bash deploy/setup.sh --step node"
command -v corepack >/dev/null || missing "corepack" "Viene con Node 24 di nodejs.org: come root, sudo bash deploy/setup.sh --step node"
command -v git >/dev/null || missing "git" "Come root: apt-get install git"
command -v bwrap >/dev/null || missing "bubblewrap (sandbox dei comandi degli agenti)" "Come root: sudo bash deploy/setup.sh --step pacchetti (apt-get install bubblewrap e, su Ubuntu 24.04, il profilo AppArmor)"
command -v socat >/dev/null || missing "socat (rete della sandbox degli agenti)" "Come root: apt-get install socat"
command -v gh >/dev/null || echo "Attenzione: manca gh (GitHub CLI): gli agenti non potranno aprire PR. Come root: apt-get install gh, poi gh auth login." >&2
# systemd dell'utente: senza sessione (via su, sudo, cron) manca XDG_RUNTIME_DIR; con linger c'è comunque.
if [[ -z "${XDG_RUNTIME_DIR:-}" && -d "/run/user/$(id -u)" ]]; then export XDG_RUNTIME_DIR="/run/user/$(id -u)"; fi
if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "systemctl --user non risponde (XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-vuoto}). Come root: loginctl enable-linger $USER" >&2
  echo "(oppure sudo bash deploy/setup.sh --step linger), poi entra di nuovo come $USER e riprova." >&2
  exit 1
fi
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != yes ]]; then
  echo "Attenzione: linger è spento, Ciccio si ferma quando esci dal server. Come root: loginctl enable-linger $USER" >&2
fi

# Prima di toccare qualcosa si aspetta che nessuna chat (né Ciccio) stia lavorando: un riavvio interrompe i giri
# in corso. Contano solo i giri al lavoro (modello o strumenti): chi è fermo ad aspettare l'utente (permessi,
# domande) e i messaggi in coda li annota lo spegnimento e all'avvio ripartono da soli (server/src/restart.ts),
# come i giri al lavoro rimasti dopo l'attesa. Al massimo WAIT_IDLE_MIN minuti (20); FORCE=1 non aspetta.
# Stampa «numero di giri al lavoro|chi sono»; "?" se non riesce a chiederlo a Ciccio.
busy() {
  local out
  if out=$(local_api "$API/activity"); then
    printf '%s' "$out" | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const a = JSON.parse(s);
          const wait = a.waiting.length ? ` (aspettano ${process.env.CICCIO_OWNER_NAME}, riprendono dopo: ${a.waiting.join(", ")})` : "";
          process.stdout.write(`${a.working.length}|${a.working.join(", ")}${wait}`);
        } catch { process.stdout.write("?"); }
      });'
    return
  fi
  # Ciccio di prima, senza /api/activity: conta ogni chat con un giro aperto, anche quelle ferme sull'utente.
  { local_api "$API/agents" || true; echo; local_api "$API/ciccio/state" || true; } | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [agents, ciccio] = s.split("\n"); let n = 0;
      try { for (const a of JSON.parse(agents)) n += (a.chats || []).filter((c) => c.running).length; } catch { n = -1; }
      try { if (n >= 0 && JSON.parse(ciccio).running) n += 1; } catch { n = -1; }
      process.stdout.write(n < 0 ? "?" : `${n}|`);
    });'
}
if [[ -z "${FORCE:-}" ]] && systemctl --user is-active --quiet ciccio.service; then
  deadline=$(( $(date +%s) + ${WAIT_IDLE_MIN:-20} * 60 ))
  while out=$(busy); n=${out%%|*}; [[ "$n" != "0" ]]; do
    who=${out#*|}; [[ "$who" == "$out" ]] && who=""
    if [[ "$n" == "?" ]]; then echo "Non riesco a leggere le chat da Ciccio: aggiorno senza aspettare."; break; fi
    if (( $(date +%s) >= deadline )); then echo "Ancora $n giri al lavoro dopo ${WAIT_IDLE_MIN:-20} minuti: aggiorno lo stesso (riprendono da soli dopo il riavvio)."; break; fi
    echo "Aspetto: $n giri al lavoro${who:+: $who} (riavvio quando sono tutti fermi; FORCE=1 per non aspettare)…"
    sleep 20
  done
fi
[[ -z "${SKIP_PULL:-}" ]] && git pull --ff-only || true
# corepack tiene pnpm in una cartella che la sandbox degli agenti non vede né scrive (dentro i dati di Ciccio):
# un agente non può cambiare il pnpm con cui si compila Ciccio.
export COREPACK_HOME="$DATA_DIR/corepack"
mkdir -p "$COREPACK_HOME" && chmod 700 "$DATA_DIR"
corepack pnpm install --frozen-lockfile
corepack pnpm build

mkdir -p "$HOME/.config/systemd/user"
if [[ ! -f "$ENV_FILE" ]]; then
  write_env
  set -a; . "$ENV_FILE"; set +a
fi
mkdir -p "${CICCIO_PROJECTS_DIR:-$HOME/projects}"
# SSH degli agenti (chiavi di 1Password via companion): niente domande interattive sull'host la prima volta,
# l'impronta si registra e poi si controlla. Le chiavi arrivano solo da SSH_AUTH_SOCK, mai da file.
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/config" && chmod 600 "$HOME/.ssh/config"
# Dentro la sandbox degli agenti (SANDBOX_RUNTIME) ssh passa dal proxy della sandbox: vedi deploy/ssh-proxy.sh.
mkdir -p "$HOME/.local/bin"
install -m 755 deploy/ssh-proxy.sh "$HOME/.local/bin/ciccio-ssh-proxy"
# Ponte SSH attraverso un PC con il companion (server della rete dell'ufficio): lo usa ciccio-ssh-proxy.
install -m 755 deploy/ssh-bridge.cjs "$HOME/.local/bin/ciccio-ssh-bridge.cjs"
sed -i '/^# BEGIN ciccio-ssh$/,/^# END ciccio-ssh$/d' "$HOME/.ssh/config"
cat >> "$HOME/.ssh/config" <<EOF
# BEGIN ciccio-ssh
Match exec "printenv SANDBOX_RUNTIME >/dev/null"
  ProxyCommand $HOME/.local/bin/ciccio-ssh-proxy %h %p
Host *
  StrictHostKeyChecking accept-new
  BatchMode yes
  ConnectTimeout 15
  ServerAliveInterval 30
# END ciccio-ssh
EOF
cp deploy/ciccio.service "$HOME/.config/systemd/user/ciccio.service"
# Schermo virtuale condiviso per i programmi grafici degli agenti (se Xvfb è installato), e l'xvfb-run che lo usa.
install -m 755 deploy/xvfb-run.sh "$HOME/.local/bin/xvfb-run"
if [[ -x /usr/bin/Xvfb ]]; then cp deploy/ciccio-display.service "$HOME/.config/systemd/user/ciccio-display.service"; fi
systemctl --user daemon-reload
if [[ -x /usr/bin/Xvfb ]]; then systemctl --user enable --now ciccio-display.service >/dev/null; fi
systemctl --user enable ciccio.service >/dev/null
systemctl --user restart ciccio.service
sleep 2
# Lo stato serve da guardare, non deve fermare lo script (systemctl esce con 3 se il servizio non è attivo).
systemctl --user --no-pager --lines=5 status ciccio.service || true

# --- Companion e app desktop dalla release firmata (deploy/fetch-release.sh) ---------------------------------------
# Solo se downloads non ha ancora le versioni pubblicate, o con CICCIO_FETCH_RELEASE=1 (=0 per non farlo mai), e solo se
# questo codice ha la chiave pubblica delle release. Se GitHub non risponde lo si dice e si va avanti: Ciccio è già
# aggiornato, i programmi per i PC si possono scaricare dopo con bash deploy/fetch-release.sh.
downloads="$DATA_DIR/downloads"
if [[ "${CICCIO_FETCH_RELEASE:-}" != 0 ]] && node scripts/release-key.mjs chiavi-del-repo >/dev/null 2>&1; then
  if [[ "${CICCIO_FETCH_RELEASE:-}" == 1 || ! -s "$downloads/companion.json" || ! -s "$downloads/app.json" ]]; then
    echo
    echo "Companion e app desktop: scarico l'ultima release firmata…"
    bash deploy/fetch-release.sh || echo "Attenzione: companion e app desktop non scaricati (GitHub non raggiungibile o release non valida). Riprova più tardi: bash deploy/fetch-release.sh" >&2
  fi
fi

# --- Cosa resta da fare --------------------------------------------------------------------------------------------
# Ciccio ascolta solo su 127.0.0.1: dalla tailnet ci arriva tailscale serve, in https con il certificato di Tailscale.
if [[ "${CICCIO_HOST:-127.0.0.1}" == "127.0.0.1" ]] && ! tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${CICCIO_PORT:-8787}"; then
  echo
  echo "Per aprire Ciccio dalla tailnet, una volta sola come root:"
  echo "  tailscale serve --bg --https=443 http://127.0.0.1:${CICCIO_PORT:-8787}"
fi
if [[ ! -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  echo
  echo "Manca il login di claude.ai: senza, gli agenti non partono. Come root: sudo bash /usr/local/lib/ciccio/setup.sh --step ciccio"
fi
# Script di root (helper con sudo, firewall): si aggiornano solo da root, dopo aver visto le differenze.
LIB=/usr/local/lib/ciccio
stale=()
differs() { [[ -f "$1" && -f "$2" ]] && [[ "$(sha256sum < "$1")" != "$(sha256sum < "$2")" ]] && stale+=("$2"); return 0; }
differs deploy/ciccio-egress-allow.sh /usr/local/sbin/ciccio-egress-allow
differs deploy/ciccio-apt-install.sh /usr/local/sbin/ciccio-apt-install
differs deploy/ciccio-app-install.sh /usr/local/sbin/ciccio-app-install
differs deploy/ciccio-ssh-allow.sh /usr/local/sbin/ciccio-ssh-allow
for f in "$LIB"/*.sh; do [[ -f "$f" ]] && differs "deploy/$(basename "$f")" "$f"; done
if (( ${#stale[@]} )); then
  echo
  echo "Gli script di root installati sono diversi da quelli del repo: ${stale[*]}"
  if [[ -f "$LIB/setup.sh" ]]; then
    echo "Per aggiornarli (mostra le differenze e chiede prima di installare), come root:"
    echo "  sudo bash $LIB/setup.sh --step copia-root"
  else
    echo "Per metterli in una copia di root (/usr/local/lib/ciccio), dopo aver controllato git -C ~/ciccio status, come root:"
    echo "  sudo bash $HOME/ciccio/deploy/setup.sh --step copia-root"
  fi
fi
