# Ciccio: com'è fatto

- `server/` — Node + Fastify + [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Una sessione Claude Code per repo in `CICCIO_PROJECTS_DIR`, coda con al massimo `CICCIO_MAX_ACTIVE` sessioni attive, permessi inoltrati alla dashboard, SQLite in `CICCIO_DATA_DIR`.
- `server/src/ciccio.ts` — il responsabile: riepilogo del giorno e smistamento dei messaggi all'agente giusto.
- `web/` — React + Vite + Tailwind, orb di [thinking-orbs](https://libraries.dev/orbs). Voce dal browser, dal servizio voce sul server (`voice/`, facoltativo) o da un servizio esterno scelto in Impostazioni › Voce.
- `shared/types.ts` — tipi comuni a server e web.
- `companion/` — programma per Mac e Windows che rende disponibili agli agenti i server MCP del PC acceso (Affinity, Chrome). Vedi [Companion dei PC](#companion-dei-pc).
- `desktop/` — app «Ciccio» per Mac e Windows (Tauri): Ciccio in una finestra sua, con le notifiche del sistema e Consenti/Rifiuta dalla notifica. Vedi [App desktop](#app-desktop).

Regole imposte agli agenti: niente push su `main`/`master` (bloccato), lavoro su branch `ciccio/…` con PR, `STATUS.md` aggiornato a fine giro.

## Sviluppo

Cosa serve per ogni parte (Node, pnpm, Bun, Swift, Rust, Python): [sviluppo.md](sviluppo.md).

```bash
pnpm install
pnpm dev:server   # API su 127.0.0.1:8787 (CICCIO_PROJECTS_DIR per scegliere i repo)
pnpm dev:web      # interfaccia su Vite con proxy verso il server
```

## Server

Gira come servizio systemd di un utente senza sudo (negli esempi `ciccio`), in ascolto su 127.0.0.1: dalla tailnet ci arriva `tailscale serve` (vedi [Accesso](#accesso)).

Installazione: `deploy/setup.sh`, come root, guida tutti i passi (vedi [installazione.md](installazione.md)); `--check` stampa lo stato, `--step NOME` rifà un passo, `--yes` accetta i default. Ogni passo ha un controllo (`check_<passo>`, senza effetti) e un'azione (`do_<passo>`) che finisce con una verifica. La parte dell'utente gira con `runuser -l <utente>` e `XDG_RUNTIME_DIR=/run/user/<uid>` (per `systemctl --user`); root non scrive mai nella home dell'utente: file e cartelle lì li crea l'utente stesso, così un link simbolico non fa scrivere root altrove. Node e modelli della voce li scarica e controlla root (che il firewall in uscita non limita), poi li installa l'utente. Il login di claude.ai lo fa l'utente con il Claude Code dell'SDK (`claude auth login --claudeai`), dopo `install.sh`: Ciccio usa solo l'abbonamento, e le variabili di accesso a consumo (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, Bedrock, Vertex, Foundry) non passano alle sessioni (`config.ts`).

**Copia di root.** Root non esegue mai script che l'utente di Ciccio (o un agente che riuscisse a scrivere nella sua home) può modificare: `setup.sh`, `egress-firewall.sh`, gli helper e i loro installatori stanno in `/usr/local/lib/ciccio`, di root. `setup.sh --step copia-root` li prende dal clone da cui root ha lanciato setup.sh o, se è già la copia di root, da `~utente/ciccio/deploy` letto come l'utente; mostra le differenze (`diff -u`) e chiede prima di installarle (da `~utente/ciccio` la risposta proposta è no, e con `--yes` non le installa); poi aggiorna gli helper di `/usr/local/sbin` che sono cambiati. `install.sh` confronta le impronte sha256 e, se gli script di root sono diversi da quelli del repo, stampa il comando. L'utente di Ciccio è scritto in `/etc/ciccio/user`: gli script di root lo usano quando non lo ricevono come argomento.

Aggiornare: `git pull` nella cartella `~/ciccio` del server e `bash deploy/install.sh` (con `SKIP_PULL=1` se il codice ci arriva in altro modo, per esempio con un `git push` sul repo del server). `install.sh` controlla prima Tailscale, Node ≥ 24 con corepack, git, bubblewrap, socat (gh solo come avviso), `systemctl --user` (imposta da sé `XDG_RUNTIME_DIR` se manca) e linger; usa un `COREPACK_HOME` dentro `CICCIO_DATA_DIR`, che la sandbox degli agenti non vede, così un agente non può cambiare il pnpm con cui si compila Ciccio.

Riavvio senza perdere lavoro (`server/src/restart.ts`):
- `install.sh` aspetta (al massimo `WAIT_IDLE_MIN` minuti, 20; `FORCE=1` non aspetta) solo le chat **al lavoro**, cioè che chiamano il modello o eseguono strumenti (`GET /api/activity`). Una chat ferma su un permesso o una domanda dell'utente non lo tiene fermo.
- Allo stop (SIGTERM, `KillMode=mixed`) Ciccio non fa partire giri nuovi, lascia `CICCIO_SHUTDOWN_GRACE_S` secondi (20) ai giri al lavoro e annota chi era a metà, con permessi in attesa e messaggi in coda.
- All'avvio le chat al lavoro (e Ciccio) riprendono da sole con un messaggio che spiega l'interruzione, dopo che i PC collegati prima sono tornati (al massimo `CICCIO_RESUME_PC_WAIT_S`, 30 s). Le chat ferme sull'utente ritrovano la card: alla risposta il giro riprende, e un permesso consentito vale per lo stesso passo rifatto. Poi ripartono i messaggi in coda.
- Niente cicli: dopo due riprese di fila senza un giro finito, o dopo un crash (nessun registro dello spegnimento), la chat resta ferma con una nota e «Continua» tra i suggerimenti.

Configurazione in `~/.config/ciccio.env` (variabili `CICCIO_*`, vedi `server/src/config.ts`), permessi 600. La prima installazione lo scrive commentato, con ogni variabile e il suo default (`install.sh env` scrive solo quello); tutte le variabili, con i default, sono in [configurazione.md](configurazione.md). Obbligatorie, `install.sh` si ferma senza:
- `CICCIO_OWNER_NAME`: il nome con cui Ciccio e gli agenti chiamano chi li usa (nei prompt, nelle note di STATUS.md: «## Serve da <nome>»).
- `CICCIO_ORIGINS`: gli indirizzi https da cui si apre Ciccio, separati da virgola; il primo è quello dei link. Di solito quello di Tailscale (`https://<server>.<tailnet>.ts.net`), più un dominio pubblico se c'è.

### Accesso

Tailscale è obbligatorio e il login pure, da qualunque rete: nessun indirizzo è fidato di per sé, nemmeno la tailnet o 127.0.0.1 (`server/src/auth.ts`).

- **Browser**: passkey. Le passkey funzionano solo in https con un nome di dominio, quindi dalla tailnet si entra da `tailscale serve` (`tailscale serve --bg --https=443 http://127.0.0.1:8787`, una volta come root), che dà un certificato valido senza dominio pubblico. Ogni indirizzo di `CICCIO_ORIGINS` ha le sue passkey: un dispositivo che entra da due indirizzi ne crea una per ciascuno.
- **App desktop e companion**: il loro token, preso una volta con il codice di collegamento.
- **Script del server** (`install.sh` che chiede chi sta lavorando prima di riavviare): l'intestazione `X-Ciccio-Local` con il token che Ciccio scrive a ogni avvio in `CICCIO_DATA_DIR/local-token` (cartella che gli agenti non vedono). Vale solo per `GET /api/activity`, `GET /api/agents`, `GET /api/ciccio/state` e `POST /api/auth/device-code` (un codice per aggiungere un dispositivo, dalla shell del server); il resto vuole la passkey.
- **Prima volta**: senza passkey registrate il codice di attivazione finisce nel registro del servizio (`journalctl --user -u ciccio | grep attivazione | tail -1`). Non scade finché non c'è una passkey e si consuma solo quando la passkey è creata (Face ID annullato: il codice vale ancora). Ogni riavvio, o un codice chiesto con il token locale, ne scrive uno nuovo al posto del precedente. Oltre 50 codici sbagliati in un'ora, da qualunque indirizzo, il codice si blocca finché non se ne crea uno nuovo.
- **Limite ai tentativi**: 10 errori in 10 minuti per indirizzo. L'indirizzo è quello della connessione; `X-Forwarded-For` conta solo se arriva da un proxy di `CICCIO_TRUST_PROXY` (di base `loopback`: tailscale serve, o Caddy verso 127.0.0.1).
- **Indirizzo non in `CICCIO_ORIGINS`**: la pagina di accesso lo dice subito (con l'indirizzo usato) invece di far fallire la passkey; le API rispondono 403 con lo stesso messaggio.
- **Prima volta e recupero**: `bash deploy/install.sh code`, come l'utente, chiede a Ciccio un codice di attivazione nuovo (`POST /api/auth/device-code` con il token locale) e lo stampa con l'indirizzo; `setup.sh` lo fa alla fine. Senza passkey registrate il codice finisce anche nel registro del servizio (`journalctl --user -u ciccio`).

### Firewall in uscita

L'utente `ciccio` non può aprire connessioni verso internet: passa solo dal proxy locale tinyproxy (127.0.0.1:8888), che lascia uscire i domini di Anthropic/Claude, GitHub (compresi `api.github.com` e i file delle release su `*.githubusercontent.com`, che servono a `deploy/fetch-release.sh`), npm, Node e PyPI e registra ogni connessione in `/var/log/tinyproxy/tinyproxy.log`. Script: `egress-firewall.sh`, come root dalla copia di root (`bash /usr/local/lib/ciccio/egress-firewall.sh`, `--remove` per annullare); `setup.sh --step firewall` lo lancia e verifica che `curl https://example.com` come `ao` fallisca e che `api.anthropic.com` risponda dal proxy. Per aggiungere un dominio fisso: modifica l'elenco `ALLOW` nello script, aggiorna la copia di root e rieseguilo.

Il firewall decide dove ci si collega, non cosa esce: non è un confine di riservatezza. Un agente può portare fuori dati da GitHub (push, issue, gist) o dagli altri domini consentiti, e con le richieste DNS, che il server risolve per lui.

Le regole sono di ufw (`/etc/ufw/before.rules`): con ufw spento lo script si ferma e spiega come accenderlo senza restare chiusi fuori (prima `ufw allow OpenSSH` e `ufw allow in on tailscale0`), invece di dire «attivo»; dopo `ufw reload` controlla che la regola per l'uid ci sia davvero (`iptables -S ufw-before-output`). Le righe del proxy in `~/.profile`, `~/.bashrc` e `ciccio.env` le scrive l'utente stesso (`runuser`), non root.

Nota: con ufw le regole si ricaricano con `ufw reload`; dopo ogni modifica verificare `grep ^ENABLED /etc/ufw/ufw.conf` e `ip6tables -S ufw6-before-input | wc -l` (deve essere > 2).

**Server SSH degli agenti** (`/etc/ciccio/ssh-hosts`, un `host` o `host:porta` per riga): il firewall lascia uscire l'utente verso quegli indirizzi, risolti quando si applicano le regole. Si cambiano con l'helper root `/usr/local/sbin/ciccio-ssh-allow add|remove|list <host[:porta]>` (uscita 0: fatto, con «OK/GIA/TOLTO <voce>» su stdout; 1: rifiutato, con il motivo in una riga su stderr), che Ciccio lancia con `sudo -n` dalle Impostazioni e che riapplica le regole; registro in `/var/log/ciccio-ssh.log`. L'helper accetta solo nomi host o IPv4 pubblici: niente loopback, reti private, link-local (169.254.x.x, i metadati del cloud), CGNAT e tailnet (100.64.0.0/10, fd7a:115c:a1e0::/48), multicast, nomi locali (`.local`, `.internal`, `.ts.net`…); un nome deve risolversi solo in indirizzi pubblici. Un server interno lo aggiunge solo root in persona, `bash /usr/local/lib/ciccio/ssh-hosts.sh add host[:porta] --privato` (mai l'utente di Ciccio via sudo): finisce anche in `/etc/ciccio/ssh-hosts-private`, e il firewall scarta gli indirizzi interni di ogni server che non è lì (un nome pubblico che domani si risolvesse in 10.x non apre la rete interna). I server già in elenco prima dell'helper li aveva messi root: alla prima esecuzione finiscono in `ssh-hosts-private`. Attivare l'helper: `bash /usr/local/lib/ciccio/ssh-helper.sh` (`--remove` per toglierlo), o `setup.sh --step helper`.

Gli agenti possono chiedere un dominio in più con lo strumento `consenti_dominio`: Ciccio controlla il nome (niente IP, porte, percorsi, caratteri jolly o nomi locali), l'utente approva ogni volta in chat e solo allora l'helper root `/usr/local/sbin/ciccio-egress-allow` lo aggiunge, rifacendo i controlli. I domini aggiunti stanno in `/etc/ciccio/egress-extra` (l'elenco del proxy è `/etc/tinyproxy/ciccio-allow-base` più questi, e rieseguire `egress-firewall.sh` li tiene), si vedono e si chiudono in Impostazioni › Server; registro in `/var/log/ciccio-egress.log`. Attivare o aggiornare l'helper (come root, dalla copia di root): `bash /usr/local/lib/ciccio/egress-helper.sh` (`--remove` per toglierlo), o `setup.sh --step helper`.

### Ogni agente solo sul suo repo

Un agente lavora solo nel repo del suo progetto (una chat in un worktree solo nel suo worktree), in ogni livello di autorizzazione (anche «Salta permessi»). Vedi `server/src/confine.ts`.

- **Sandbox dei comandi** (sandbox di Claude Code con bubblewrap): i comandi Bash non vedono gli altri progetti, `~/ciccio`, `~/.ciccio`, `ciccio.env`, `~/.claude` (cronologia, piani, sessioni e impostazioni di tutti i progetti, credenziali di Claude; restano visibili solo skill, plugin e le istantanee della shell di Claude Code), `~/.ssh` (tranne `config` e `known_hosts`, in sola lettura), `~/.npmrc`, `~/.git-credentials` e le altre credenziali. Scrivono solo nella cartella della chat, in `$TMPDIR` e nelle cartelle del progetto in `~/.ciccio/progetti/<progetto>/` (cache dei pacchetti di npm, pnpm, corepack, uv e pip e `known_hosts`, scelte con le variabili d'ambiente della sessione): un progetto non può avvelenare le cache o gli host SSH degli altri, e le cache dell'utente (`~/.npm`, `~/.cache/…`) sono in sola lettura. Nella cartella della chat restano in sola lettura `.claude/`, `.mcp.json`, `.gitmodules`, hook e config di git e, dalla cartella principale, i worktree delle altre chat (`.ciccio/worktrees/`). Per i file protetti che non esistono la sandbox monta file o cartelle vuote nella cartella della chat (`.bashrc`, `.gitconfig`, `.zshrc`, `.mcp.json`, `.vscode/`, `.idea/`, `.claude/`…): sul disco non ci sono, ma dentro la sandbox `git status` li vedrebbe come non tracciati. Perché un `git add -A` dell'agente non li committi, la sessione passa a git `core.excludesFile` con `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` (`sandboxGitEnv` in `server/src/confine.ts`): il file è `~/.ciccio/progetti/<progetto>/git-exclude`, leggibile e non scrivibile dalla sandbox, con quei percorsi ancorati alla radice del repo e in fondo le esclusioni globali dell'utente (che `core.excludesFile` altrimenti sostituirebbe). Il repo, il suo `.gitignore` e `.git/info/exclude` non si toccano; il git del server, fuori dalla sandbox, non lo usa. Se bubblewrap manca la sessione non parte. Sul server servono `bubblewrap`, `socat` e, su Ubuntu 24.04, il profilo AppArmor `/etc/apparmor.d/bwrap` (`userns,`), come da [documentazione](https://code.claude.com/docs/en/sandboxing).
- **Rete**: i comandi della sandbox e WebFetch non raggiungono questa macchina (l'API di Ciccio su 127.0.0.1:8787, tinyproxy, la voce, gli indirizzi delle sue interfacce), le reti private e link-local e la tailnet (100.64.0.0/10, `fd7a:115c:a1e0::/48`); un nome vale per tutti gli indirizzi a cui porta.
- **ssh, scp, rsync** dalla sandbox passano dal suo proxy (`Match exec` in `~/.ssh/config` e `~/.local/bin/ciccio-ssh-proxy`, messi da `install.sh`) e poi vanno diretti ai server dell'elenco SSH.
- **Strumenti fuori dalla sandbox** (Read, Edit, Write, Glob, Grep): stessi limiti, controllati da Ciccio in un hook PreToolUse (gira prima di ogni regola di permesso, anche nei sub-agent) e di nuovo nella richiesta di permesso. Scrivono solo nella cartella della chat e nella memoria del progetto; mai in `.git`, `.claude/`, `.mcp.json` e `.gitmodules`, a qualsiasi profondità (anche dentro un worktree), né nei worktree delle altre chat. Non leggono `~/.claude` (tranne skill e plugin), `~/.ssh`, `~/.config/gh` e le altre credenziali.
- **File di Claude Code nel repo**: le sessioni leggono `CLAUDE.md`, le skill e i comandi del repo, ma con le impostazioni di blocco (`sessionLockdown`) non valgono gli hook dei file di impostazioni (`.claude/settings*.json` e `~/.claude/settings.json`), le loro regole di permesso (decide solo Ciccio), i server MCP di `.mcp.json` e delle impostazioni (girerebbero fuori dalla sandbox) e gli agenti di `.claude/agents/` e `~/.claude/agents/`; `allowed-tools` di skill e comandi non vale. Gli strumenti MCP di un progetto si propongono con `proponi_server_mcp`, che li chiude nella sandbox. Un file di impostazioni gestite di Claude Code sul server (in `/etc/claude-code/`) vale sopra queste: non deve esserci, o deve essere dell'amministratore e scritto apposta.
- **Memoria del progetto**: in `~/.ciccio/progetti/<progetto>/memoria/` (`autoMemoryDirectory`), una per progetto anche quando i nomi si somigliano (`a-b` e `a_b` prima finivano nella stessa cartella di `~/.claude/projects`). Alla prima sessione Ciccio copia lì la memoria di prima, se non era in comune con un altro progetto; quella vecchia resta dov'era.
- **GitHub**: il token di gh vale per tutti i repo, quindi Ciccio blocca i comandi che nominano un altro repo (URL, `-R/--repo`, `gh api repos/…`), `git clone`, remote nuovi, `git -c`/`git config` su remote, credenziali, hook e fsmonitor, `gh repo` (tranne `view`), `gh search`, `gh api graphql` e i modi evidenti di leggere il token (`gh auth token`, `gh auth status -t`, `gh auth git-credential`, `git credential`, `~/.config/gh`). Read, Glob e Grep non vedono `~/.config/gh`. I comandi della sandbox invece sì, perché gh e `git push` ne hanno bisogno: un comando scritto apposta può ancora leggere il token. È un controllo sui comandi, non un limite del token: per limitare il danno usa per Ciccio un token fine-grained solo sui repo dei progetti.
- **git del server** (File, Modifiche, worktree, progetti nuovi) gira fuori dalla sandbox, quindi sempre con `core.hooksPath=/dev/null`, `core.fsmonitor=false` e senza `/etc/gitconfig` (`server/src/git.ts`).
- **Ambiente**: alle sessioni passano solo le variabili che servono a Claude Code e a git/gh (percorsi, lingua, proxy, certificati, `ANTHROPIC_*`, `CLAUDE_CODE_*`, `GH_TOKEN`), niente `CICCIO_*` né altre chiavi di `ciccio.env` (`claudeEnv` in `server/src/config.ts`). La chiave di Anthropic la usa solo il processo di Claude Code: ai comandi nella sandbox la toglie `sandbox.credentials`. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` la toglierebbe anche a hook e server MCP, ma toglie pure `SSH_AUTH_SOCK` e con lui le chiavi SSH della chat: non si usa.
- **Segreti di 1Password** (`usa_credenziale`, `server/src/credentials.ts`): il comando lo lancia il server, quindi gira nella sandbox degli strumenti su misura (`toolSandbox.ts`) con l'ambiente filtrato più i segreti chiesti. La card mostra prima il comando, intero; comandi oltre 2000 caratteri o motivi oltre una riga di 200 sono rifiutati invece di essere tagliati. Fuori da Linux gira solo con `CICCIO_TOOLS_NO_SANDBOX=1`.
- **Ciccio**: i suoi Read, Glob e Grep hanno le stesse zone vietate degli agenti; vede i repo dei progetti in sola lettura (non ha strumenti che scrivono), non i dati di Ciccio, `ciccio.env`, il token locale o le credenziali di Claude.
- **Consenti sempre**: la card dice la regola esatta che salva. Per Bash è l'inizio del comando (le prime due parole) e vale solo per comandi semplici: niente `;`, `&`, `|`, `&&`, `||`, a capo, `$( )`, backtick o redirezioni fuori dal repo, quindi «npm test» non fa passare «npm test && curl …». Per gli altri strumenti è lo strumento intero, tranne le azioni dei connettori e dei server MCP (inviare, creare, modificare…), che chiedono ogni volta e non hanno «sempre».

### Domande a scelte

Quando un agente (o Ciccio) usa lo strumento `AskUserQuestion`, sopra il campo di testo compare la finestra con le domande, come nell'app di Claude: opzioni numerate, scelta multipla, «Qualcos'altro», «Salta», «2 di 3»; tasti 1-4, Invio, ←→, Esc. Non è un permesso: arriva all'utente in ogni livello, anche «Ignora autorizzazioni». Passa dalla tabella `approvals` (`tool = 'AskUserQuestion'`), quindi resta dopo un ricaricamento, conta come «Ti aspetta» e si chiude se il giro viene fermato; la risposta (`POST /api/approvals/:id/answer`) torna all'agente come `answers` nell'input dello strumento.

### Programmi di sistema su richiesta

`ciccio` non ha sudo, quindi un agente non può installare da sé un programma che manca (es. `openscad`). Lo chiede con lo strumento `installa_programma({ pacchetto, motivo })` (`server/src/systemPackages.ts`):

1. Ciccio controlla il nome e, senza root, simula l'installazione (`apt-get -s`): se il pacchetto è già installato lo dice all'agente, se non esiste o non va bene (vedi sotto) rifiuta senza disturbare l'utente.
2. L'utente approva nella card dei permessi, che mostra pacchetto, motivo, numero di dipendenze ed eventuali librerie aggiornate. Lo chiede **sempre**, in ogni livello di autorizzazione («Salta permessi» compreso) e senza «consenti sempre»; nemmeno Ciccio può approvare al posto suo.
3. Dopo il sì il server lancia `sudo -n /usr/local/sbin/ciccio-apt-install <pacchetto>`, l'esito torna all'agente e in chat compare la riga «installato openscad 2021.01». Da lì i comandi che usano il programma seguono il livello della chat come gli altri.

L'helper (`deploy/ciccio-apt-install.sh`) rifà tutti i controlli da root, senza fidarsi di Ciccio:

- **solo un nome di pacchetto** (`[a-z0-9.+-]`): niente versioni, architetture, file `.deb`, URL, PPA o opzioni; il nome deve essere esatto (niente pacchetti virtuali o «selecting … instead of …»);
- **solo pacchetti ufficiali di Ubuntu**, dipendenze comprese: simulazione e installazione vedono solo le sorgenti di Ubuntu (una copia di `ubuntu.sources` al posto di `sources.list.d`, con la cache dei pacchetti rifatta in memoria), quindi i repository di Docker, Caddy, NodeSource, Tailscale presenti sul server per queste chiamate non esistono; in più ogni pacchetto deve avere origine `Ubuntu`; nessun repository o chiave nuova;
- l'installazione è **esattamente quella simulata**: `apt-get install -y --no-install-recommends --no-remove` con l'elenco `pacchetto=versione` della simulazione (le dipendenze restano segnate come automatiche); **niente rimozioni**, niente aggiornamenti di sistema, un pacchetto già installato non si tocca; le dipendenze già presenti si aggiornano solo se il pacchetto lo richiede. needrestart non riavvia servizi;
- una installazione alla volta; ogni richiesta (anche rifiutata) finisce in `/var/log/ciccio-apt.log` con data, utente, pacchetto, esito, progetto e chat; apt registra il resto in `/var/log/apt/history.log`.

La regola sudo (`/etc/sudoers.d/ciccio-apt`) consente a `ciccio` solo l'helper. I comandi degli agenti girano nella sandbox (bubblewrap, flag *no new privileges*), dove `sudo` non parte proprio: l'helper lo raggiunge solo il server di Ciccio dopo l'approvazione. Chi avesse una shell come `ciccio` fuori dalla sandbox potrebbe invece installare pacchetti ufficiali di Ubuntu senza chiedere: è il limite di questa scelta.

Attivare o aggiornare l'helper (come root, dalla copia di root; `setup.sh --step copia-root` lo aggiorna da sé quando cambia `deploy/ciccio-apt-install.sh`):

```bash
bash /usr/local/lib/ciccio/apt-helper.sh
```

Toglierlo (gli agenti riceveranno «l'installazione dal server non è attiva»; i pacchetti installati restano, si tolgono a mano con `apt-get purge`):

```bash
bash /usr/local/lib/ciccio/apt-helper.sh --remove
```

### Routine

Messaggi che il server manda da solo a un progetto a orari fissi, come se li scrivesse l'utente (`server/src/routines.ts`). Ogni giro di un agente è un processo che si chiude a fine risposta: CronCreate, `/loop` e ScheduleWakeup di Claude Code morirebbero con lui, quindi l'orologio lo tiene il server.

- **Quando**: cron a 5 campi nel fuso di Ciccio (`CICCIO_TZ`, di serie quello del sistema; `shared/cron.ts`, minuto ora giorno mese giorno-della-settimana); la pagina lo costruisce da «ogni giorno alle…», «giorni della settimana», «ogni N ore» e mostra le prossime esecuzioni. Il server controlla ogni 20 secondi; le esecuzioni perse a server spento non si recuperano.
- **Dove**: una chat nuova a ogni esecuzione, senza contesto (costa solo il prefisso, uguale per tutte le chat del progetto; la chat della volta prima va in archivio se è ferma), oppure una chat fissa con la sua sessione. Il livello delle chat nuove lo sceglie l'utente per ogni routine: in Manuale l'esecuzione si ferma a ogni permesso, anche per aggiornare STATUS.md.
- **Chat occupata**: il messaggio va in coda come quelli dell'utente; se è ancora al lavoro l'esecuzione precedente della stessa routine, la nuova aspetta che finisca.
- **Consumo**: oltre la soglia di Impostazioni › Routine (finestra di 5 ore dell'abbonamento, 80% di partenza) le esecuzioni programmate saltano e Ciccio lo dice; «Lancia ora» parte comunque. Ogni esecuzione registra durata, token letti e scritti, costo equivalente API (`total_cost_usd`) e la finestra di 5 ore prima e dopo; la pagina somma 7 e 30 giorni.
- **Chi le crea**: l'utente da Impostazioni › Routine o dal pannello del progetto; un agente con `crea_routine` (solo per il suo progetto) e Ciccio con lo strumento `routine`, sempre con la conferma dell'utente. Agenti e Ciccio non scelgono il livello.
- L'esito arriva come avviso di Ciccio, con le regole degli altri giri; il messaggio in chat porta l'etichetta della routine e l'agente sa dalla riga `[Adesso]` che è partito da solo.

### Strumenti su misura per progetto

Come il server «comandi» del companion, ma sul server (`server/src/projectTools.ts`): ogni giro ha un server MCP `ciccio_strumenti` con

- `proponi_comando`: un programma del server o uno script del repo, con argomenti fissi e segnaposto tipizzati (`file` del repo, `uscita` nel repo, `numero`, `testo` tra valori ammessi), senza shell;
- `proponi_server_mcp`: un server MCP stdio (es. `npx -y pacchetto@versione`) o un indirizzo `https` pubblico;
- `crea_routine`, vedi sopra;
- gli strumenti già approvati del progetto.

La card mostra il comando esatto e ha solo **Consenti sempre** (salva lo strumento nel progetto) e **Rifiuta**; Ciccio non può approvarla. Da lì lo strumento c'è in tutte le chat del progetto, dal messaggio successivo, finché l'utente non lo toglie dalla scheda Impostazioni del pannello del progetto. Usarlo segue il livello della chat: in Auto passano solo quelli approvati come sola lettura; «Consenti sempre» sull'uso diventa una normale regola del progetto.

- **Sandbox**: comandi e server MCP stdio girano in bubblewrap (`server/src/toolSandbox.ts`) con le zone vietate di `confine.ts`: disco in sola lettura, altri progetti, dati di Ciccio, credenziali (token di gh compreso) e socket di sistema nascosti; scrivibili solo il repo, le cache dei pacchetti del progetto e una cartella temporanea. Nel repo `.git`, `.claude`, `.mcp.json`, `.gitmodules` e i worktree delle altre chat restano in sola lettura. Variabili d'ambiente filtrate (niente token). La rete passa comunque dal firewall in uscita.
- **Script del repo**: programma e argomenti fissi che sono file del repo si ricordano con l'impronta sha256; se cambiano, lo strumento si ferma finché l'utente non lo toglie e l'agente lo ripropone.
- **Niente chiavi**: proposte con valori che sembrano segreti sono rifiutate (per ora niente riferimenti a 1Password negli strumenti del server).
- **Cache**: gli strumenti del server sono differiti dietro ToolSearch (`alwaysLoad: false`) e il server non ha istruzioni: uno strumento nuovo arriva come annuncio nei messaggi, senza riscrivere il prefisso della conversazione.
- Fuori da Linux (prove sul PC) non c'è bubblewrap: gli strumenti girano solo con `CICCIO_TOOLS_NO_SANDBOX=1`.

## Companion dei PC

Il companion è un piccolo programma per Mac e Windows: rende disponibili agli agenti sul server i server MCP del PC acceso in quel momento (Affinity, Chrome su un profilo dedicato, altro a scelta).

```
PC (Mac/Windows)                                  VPS
┌──────────────────────────┐   wss, in uscita   ┌──────────────────────────────┐
│ ciccio-companion         │ ─────────────────▶ │ tailscale serve (o Caddy)    │
│                          │                    │ → Ciccio  /companion         │
│  ├─ affinity (SSE :6767) │  token dispositivo │  registro dei PC collegati   │
│  └─ chrome (npx, stdio)  │ ◀── tools/call ─── │  server MCP "pc_<nome>"      │
└──────────────────────────┘                    │  → sessioni agente e Ciccio  │
                                                └──────────────────────────────┘
```

- **Solo in uscita.** Il PC apre la WebSocket verso `<server>/companion`, il server con cui è stato collegato; sul PC non si apre nessuna porta. Il firewall in uscita del server non cambia: la connessione arriva da fuori.
- **Token per dispositivo.** Si genera in Ciccio › **Impostazioni › Companion › Genera token** (dalla dashboard, ingranaggio in alto); si vede una volta sola e nel database resta solo l'hash (tabella `devices`). «Scollega» lo invalida e chiude il collegamento.
- **Stessi permessi delle chat.** Gli strumenti si chiamano `mcp__pc_<nome>__<server>_<strumento>` (es. `mcp__pc_mac__affinity_execute_script`) e passano da `canUseTool` come tutti gli altri: in Manuale e Accetta modifiche chiedono sempre, in Auto passano da soli solo quelli di lettura (nome `list_*`, `get_*`, `read_*`… o `readOnlyHint` del server; uno strumento che si dichiara un'azione, `readOnlyHint: false`, chiede anche se si chiama `list_…`), in Ignora autorizzazioni passano tutti. Il server li registra con `always_ask`, così nessuna regola delle impostazioni utente li fa passare di nascosto.
- **Interruttore per progetto.** «Companion» nelle impostazioni della chat, vale per tutto il progetto (acceso di default). Vale dal messaggio successivo: gli strumenti di un PC acceso a giro già iniziato arrivano dal messaggio dopo.
- **Solo quello che scegli.** Il companion espone solo i server della sua config, con filtri `allow`/`deny` per strumento. Ciccio non salva argomenti né risultati fuori dalla chat; il companion scrive nel terminale solo nome dello strumento, esito e durata.
- **Decide il PC.** Cartelle nuove (`chiedi_accesso`), comandi nuovi (`proponi_comando`) e server MCP nuovi (`proponi_strumento`) gli agenti li possono solo chiedere: compare una finestra sul PC e solo chi è lì li aggiunge alla config. Da Ciccio non c'è nessun modo di allargare quello che il PC offre.

### Installazione sul Mac

```bash
pnpm install
pnpm companion:build                       # binari in dist/companion/
cp dist/companion/ciccio-companion-darwin-arm64 ~/.local/bin/ciccio-companion
```

Poi, con il token generato in Ciccio › Impostazioni › Companion:

```bash
ciccio-companion init ccp_…                # crea ~/.ciccio-companion/config.json (permessi 600)
ciccio-companion check                     # prova i server MCP locali ed elenca gli strumenti
ciccio-companion                           # si collega e resta acceso, stato nel terminale
ciccio-companion install                   # avvio automatico all'accesso (LaunchAgent), in background
ciccio-companion status                    # è acceso? ultime righe di ~/.ciccio-companion/companion.log
ciccio-companion stop                      # chiude quello in background (uninstall toglie anche l'avvio automatico)
```

Un solo companion per utente: se ce n'è già uno in background, `ciccio-companion` in un terminale lo dice e non parte (prima `stop`).

Con l'app installata, `ciccio-companion` non è nel PATH: si usa il percorso del programma (è quello che mostra Ciccio in «Avanzato: collega da terminale con un token»). `init` salva il token e ricollega da solo il companion acceso.

- **Mac**, nel Terminale: `"/Applications/Ciccio Companion.app/Contents/Resources/ciccio-companion" init ccp_…`
- **Windows**, in PowerShell: `& "$env:USERPROFILE\.ciccio-companion\bin\ciccio-companion.exe" init ccp_…`

La prima volta `init` vuole anche il server (`--server https://ciccio.tuo-tailnet.ts.net`); dopo usa quello salvato. Con `--server` si cambia server.

Per Affinity: in Affinity › Impostazioni attiva il server MCP (ascolta su `localhost:6767`); il companion ci parla direttamente, senza Claude desktop. Se Affinity è chiuso il server risulta «non disponibile» e il companion riprova ogni 30 secondi.

Per Chrome: la config usa [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) con un profilo dedicato in `~/.ciccio-companion/chrome-profile` e le statistiche verso Google spente (`--usageStatistics=false`, `--performanceCrux=false`). Serve Node sul PC (per `npx`). Al primo uso Chrome si apre con il profilo vuoto: accedi a mano ai siti che servono agli agenti, poi restano.

### Installazione su Windows

Un solo file, `CiccioCompanion-windows.exe`: niente installatore e niente Node per il companion (Node serve solo per i server MCP lanciati con `npx`, come Chrome).

1. **Scarica**: in Ciccio, da Windows, apri Impostazioni › Companion (ingranaggio in alto nella dashboard) › «Scarica Ciccio Companion per Windows».
2. **Doppio clic sul file scaricato.** SmartScreen avvisa perché non è firmato: «Ulteriori informazioni» › «Esegui comunque». Si installa da solo nella cartella utente, senza amministratore (copie in `%USERPROFILE%\.ciccio-companion\bin`, link `ciccio-companion://`, avvio all'accesso) e accende l'**icona di Ciccio nell'area di notifica**, in basso a destra. Se non è ancora collegato, una finestra dice come fare. Il file scaricato poi si può cancellare.
3. **«Collega questo PC»** nella stessa scheda di Ciccio (nome, per esempio `windows`): il browser chiede di aprire Ciccio Companion, poi una finestra chiede «Collegare questo PC a Ciccio?» › «Collega». Il companion controlla il token con Ciccio, salva la config e l'icona lo accende; alla fine «PC collegato a Ciccio».

**L'icona** fa su Windows quello che l'app della barra dei menu fa sul Mac, con le stesse voci:

- la «C» di Ciccio piena quando è collegato, sbiadita quando no (suggerimento «Ciccio Companion · collegato / non collegato»), aggiornata ogni 2 secondi da `status.json`;
- menu con clic destro o sinistro: stato («● Collegato come «windows»» e una riga per server, oppure il problema), **Apri Ciccio**, **Ricollega**, **Avvia all'accesso** (spunta), **Notifiche di Ciccio** (spunta), **Permessi…** (con quante voci sono da attivare), **Strumenti esposti…** (la config nel Blocco note), **Registro**, **Esci**;
- tiene acceso il companion: se si chiude riparte da solo (attesa crescente fino a 30 secondi); «Ricollega» gli chiede di chiudersi e lo riaccende, e se dopo 5 secondi è ancora lì lo chiude a forza con tutti i suoi processi. Il menu non aspetta mai il companion;
- all'avvio chiude un companion rimasto acceso da solo; «Esci» chiude anche il companion e i suoi server MCP;
- si aggiorna da sola (vedi Aggiornamento automatico).

Com'è fatta: icona, menu e finestre sono Windows Forms in PowerShell 5.1, che c'è su ogni Windows 10/11; gli script stanno dentro l'.exe e vengono scritti in `%USERPROFILE%\.ciccio-companion\ui`. La logica (riavvii, Ricollega, aggiornamento) è nel companion stesso (`companion/src/tray.ts`), come `main.swift` sul Mac.

Un link da un altro sito non può dirottare gli strumenti del PC (`companion/src/pair.ts`, e `main.swift` sul Mac):
- **PC già collegato**: il link vale solo per il server della config; per cambiarlo serve `init <token> --server <indirizzo>` da terminale.
- **Prima volta**: solo https (http solo verso questo computer, per le prove) e sempre dopo una conferma che mostra l'indirizzo («Collegare questo PC a ciccio.tuo-tailnet.ts.net?»). `--yes` la salta, ma solo scritto a mano in un terminale: il link del browser non lo passa mai.

Da PowerShell, nella cartella dell'.exe (o in `%USERPROFILE%\.ciccio-companion\bin`):

```powershell
.\ciccio-companion.exe status            # icona e companion accesi? collegato? ultime righe del registro
.\ciccio-companion.exe check             # prova Affinity e Chrome ed elenca gli strumenti
.\ciccio-companion.exe reconnect         # come «Ricollega» nel menu dell'icona
.\ciccio-companion.exe notifications off # come «Notifiche di Ciccio» (on per riaccenderle)
.\ciccio-companion.exe permissions       # finestra dei permessi (--json: solo i controlli)
.\ciccio-companion.exe stop              # chiude icona e companion (con i server MCP figli)
.\ciccio-companion.exe run               # acceso in questa finestra, Ctrl+C per chiudere (prima stop)
.\ciccio-companion.exe install           # riaccende icona e avvio automatico
.\ciccio-companion.exe uninstall         # toglie avvio automatico, link e copie (la config resta)
.\ciccio-companion.exe init ccp_…        # in alternativa al link: token generato da «Altri PC o da terminale»
```

Come funziona: la copia senza console (`ciccio-companion-background.exe`) è lo stesso programma con l'intestazione «GUI» al posto di «console», quindi non apre finestre. La chiave `HKCU\…\CurrentVersion\Run` dell'utente la avvia come icona (`tray`) a ogni accesso (le attività pianificate all'accesso vorrebbero l'amministratore), e l'icona avvia il companion. Lo stato va in `%USERPROFILE%\.ciccio-companion\companion.log` e `status.json`. Le installazioni della 0.3.0 (avvio automatico senza icona) passano all'icona da sole al primo avvio della versione nuova.

#### Notifiche e permessi su Windows

Gli avvisi di Ciccio (giro finito, permesso richiesto, agente bloccato) arrivano come **notifiche di Windows** con l'icona di Ciccio, al posto di quelle del browser; il clic (o «Apri la chat») apre la chat nel browser. Il companion le lascia in `%USERPROFILE%\.ciccio-companion\notify`, l'icona le mostra entro un secondo e le cancella; quelle di più di 10 minuti fa (PC spento) si scartano.

- Perché Windows mostri le notifiche di un programma non pacchettizzato serve un'identità (AppUserModelID `it.costa.ciccio-companion`): all'installazione, e all'avvio dell'icona se manca, Ciccio Companion la registra in `HKCU\Software\Classes\AppUserModelId` (nome e icona) e crea il collegamento «Ciccio Companion» nel menu Start con lo stesso ID. Niente amministratore. Il collegamento avvia l'icona, utile dopo «Esci».
- Le notifiche sono toast di Windows mostrati da PowerShell (Windows Runtime, già presente in Windows 10/11) con un clic «protocollo»: niente da installare.
- «Notifiche di Ciccio» nel menu le spegne o le riaccende (cambia solo `notifications` in `config.json`) e ricollega il companion, così Ciccio sa se mandarle a questo PC.

**Permessi di Ciccio Companion** (finestra che si apre al primo avvio, prima della guida all'abbinamento, e dal menu «Permessi…»): cosa serve perché funzioni bene, ognuno con il suo stato e il pulsante verso la pagina giusta.

| Voce | Cosa controlla | Pulsante |
|---|---|---|
| Notifiche di Ciccio Companion | stato reale per l'AppUserModelID (accese, spente per l'app, spente per tutte le app, bloccate dai criteri) e l'opzione del menu | Impostazioni › Sistema › Notifiche (`ms-settings:notifications`), dove l'app compare come «Ciccio Companion» |
| Non disturbare | Windows non dice ai programmi se è attivo: è un promemoria (le notifiche finiscono nel centro notifiche senza comparire) | Notifiche (Windows 11) / Assistente notifiche (Windows 10, `ms-settings:quiethours`) |
| Avvio all'accesso | chiave Run e interruttore di Impostazioni › App › Avvio (`StartupApproved\Run`) | «Attiva» se manca, altrimenti `ms-settings:startupapps` |
| Node.js (per Chrome) | solo se un server MCP usa `npx`: c'è `npx`? | pagina di download di Node.js |
| Affinity | solo se c'è `affinity` nella config: il server MCP risponde? | nessuno: si accende in Affinity › Modifica › Impostazioni › Model Context Protocol |

Non servono altri permessi: il firewall non va toccato (il companion si collega solo in uscita) e SmartScreen chiede conferma solo la prima volta che si apre l'.exe scaricato. «Avvia all'accesso» nel menu, se acceso, vale anche quando era stato spento in Impostazioni › App › Avvio.

Note per Windows:

- **Affinity**: stesso server dell'app su `http://localhost:6767/sse`, da accendere in Affinity › Modifica › Impostazioni › Model Context Protocol. Lì conviene lasciare spenti «Share task hints with Affinity» e le funzioni Canva AI.
- **Chrome**: profilo dedicato in `%USERPROFILE%\.ciccio-companion\chrome-profile`, lanciato con `npx` (serve Node). Nei percorsi della config valgono `~/…` e le variabili come `%USERPROFILE%` o `%LOCALAPPDATA%`.
- **Chiusura**: Ctrl+C, la chiusura della finestra e `stop` chiudono anche i server MCP figli; su Windows il companion chiude tutto l'albero dei processi di `npx`, così non restano processi orfani.
- **Token**: la config sta nella cartella utente, che Windows rende leggibile solo a te.

### Pubblicare l'.exe su Ciccio

L'.exe buono è quello compilato su Windows dalla CI «Companion Windows», con icona e dati del file; `pnpm companion:build` dal Mac fa un .exe uguale ma con l'icona generica. La release firmata (vedi [Firma delle release](#firma-delle-release)) prende proprio quello; sul server lo mette in `~/.ciccio/downloads` `bash deploy/fetch-release.sh`, e da lì si scarica da Impostazioni › Companion. Un .exe copiato a mano in `downloads` si scarica, ma i companion già installati non ci si aggiornano: vogliono `companion.json` firmato.

### Prova sul PC Windows

1. Metti l'.exe sul server (sopra). Sul PC Windows, con Affinity aperto e il server MCP acceso: scarica da Impostazioni › Companion e fai doppio clic. Deve comparire l'icona di Ciccio (sbiadita) nell'area di notifica, con la finestra «Collega Ciccio Companion» › «Apri Ciccio».
2. «Collega questo PC», poi «Collega» nella finestra: «PC collegato a Ciccio», l'icona diventa piena e il suggerimento dice «collegato».
3. Clic sull'icona: «● Collegato come «windows»», `affinity: 8 strumenti`, `chrome: 32 strumenti`, poi le voci come sul Mac. Prova «Strumenti esposti…» (Blocco note con la config) e «Registro».
4. In una chat: «Elenca gli strumenti di Affinity che hai dal PC Windows e leggi l'elenco della documentazione dell'SDK». L'agente usa `mcp__pc_windows__affinity_list_sdk_documentation` (in Manuale chiede il permesso); nel Registro compaiono `→ affinity · list_sdk_documentation` e `← … ok`.
5. «Ricollega»: l'icona si sbiadisce per un attimo e torna piena; il menu resta usabile tutto il tempo.
6. In Gestione attività chiudi a forza il processo `ciccio-companion-background` che non è l'icona (quello con più memoria): entro pochi secondi l'icona lo riaccende.
7. Esci e rientra in Windows: l'icona riparte da sola. Togli la spunta da «Avvia all'accesso», esci e rientra: non riparte; rimettila.
8. «Esci»: l'icona sparisce, in Ciccio il PC risulta spento e in Gestione attività non restano `ciccio-companion-background` né `node` di Chrome.
9. Notifiche: alla prima apertura dopo l'installazione compare «Permessi di Ciccio Companion» con le voci in verde (o il motivo e il pulsante); chiusa, se il PC non è collegato, arriva «Collega Ciccio Companion». Con il PC collegato, quando un agente finisce un giro in una chat che non stai guardando compare una notifica «Ciccio · <agente>» con l'icona di Ciccio; il clic apre quella chat nel browser. In Impostazioni › Sistema › Notifiche c'è «Ciccio Companion». Togli la spunta a «Notifiche di Ciccio»: le notifiche tornano nel browser; rimettila.
10. Aggiornamento: con l'icona accesa metti sul server una versione più alta firmata (`bash deploy/fetch-release.sh` dopo una release, o `pnpm companion:publish` con la chiave); entro pochi secondi l'icona sparisce e ricompare da sola e `.\ciccio-companion.exe status` (in `bin`) mostra la versione nuova.

### Prova automatica

`pnpm exec tsx companion/test/e2e.ts <binario>` prova un binario compilato contro un Ciccio di prova nello stesso processo: abbinamento con il link (anche server estraneo e token sbagliato), collegamento, uno strumento chiamato attraverso un server MCP lanciato con `npx`, `stop` senza processi orfani. Su Windows la CI «Companion Windows» (`.github/workflows/companion-windows.yml`) la esegue sull'.exe compilato e prova anche l'icona (`companion/test/tray-windows.ts`: avvio, stato nel menu, «Ricollega» anche con il companion congelato, riavvio dopo un crash, stop, passaggio dalla 0.3.0), notifiche e permessi (`companion/test/notify-windows.ts`: AppUserModelID e collegamento nel menu Start, guida al primo avvio, controlli dei permessi, avviso di Ciccio fino alla notifica di Windows, «Notifiche di Ciccio» spente e riaccese), l'aggiornamento automatico (`companion/test/update-windows.ts`, con una chiave delle release usa e getta: prima un manifest firmato da un'altra chiave, rifiutato, poi quello giusto), le firme e i consensi di 1Password (`companion/test/firme.ts`, anche con Bun) e l'installazione (`companion/test/windows-autostart.ps1`).

### Config

```json
{
  "server": "https://ciccio.tuo-tailnet.ts.net",
  "token": "ccp_…",
  "mcpServers": {
    "affinity": { "type": "sse", "url": "http://localhost:6767/sse", "deny": ["search_sdk_hints", "add_sdk_hint", "report_sdk_issue"] },
    "chrome": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.11.0", "--userDataDir", "~/.ciccio-companion/chrome-profile", "--usageStatistics=false", "--performanceCrux=false", "--redactNetworkHeaders"],
      "env": { "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1" }
    },
    "file": { "type": "builtin", "builtin": "file", "roots": [] },
    "comandi": { "type": "builtin", "builtin": "comandi", "comandi": {} }
  },
  "migrazioni": ["comandi", "file"]
}
```

- Oltre ai server MCP esterni ci sono i server integrati `file` e `comandi` (voci `"type": "builtin"`, vedi sotto), spenti se la voce manca. Le config nuove hanno già `comandi` (vuoto: solo le proposte) e `file` (senza cartelle: le chiede l'agente con `chiedi_accesso`). In una config di prima li aggiunge il companion al primo avvio della 0.7.1, una volta sola: le migrazioni fatte si segnano in `"migrazioni"`, quindi una voce tolta apposta non ricompare.
- Ogni server è come in `.mcp.json`: `command`/`args`/`env`/`cwd` per stdio, oppure `type` `sse` o `http` con `url` (e `headers`). `~/` nei percorsi è la cartella utente.
- **Chiavi solo da 1Password.** In `env` e `headers` un valore `op://vault/elemento/campo` è un riferimento a 1Password: il companion lo legge con la CLI `op` all'avvio del server (1Password chiede Windows Hello o Touch ID), lo tiene solo in memoria e lo legge una volta per accensione del companion; nella config resta il riferimento. Se 1Password non lo dà, il server resta spento e si riprova ogni 10 minuti (non ogni 30 secondi: ogni tentativo è una finestra).
- **La config si ricarica da sola.** Quando `config.json` cambia (a mano, con una sostituzione atomica `config.json.tmp` + rename, o per una proposta accettata sul PC) il companion avvia i server nuovi, ferma quelli tolti o con `"disabled": true` e riavvia solo quelli la cui voce è cambiata; Ciccio lo sa subito, senza «Ricollega». Una config non valida non tocca niente (lo scrive nel registro: `config cambiata ma non valida…`). Token e server di Ciccio cambiati valgono dopo «Ricollega».
- `allow` (solo questi) e `deny` (mai questi) accettano nomi e schemi con `*`; `"disabled": true` spegne un server senza toglierlo.
- Di Affinity sono esclusi di default gli «SDK hints» e le segnalazioni, che finiscono in un archivio condiviso di Canva.
- `CICCIO_COMPANION_TOKEN` e `CICCIO_COMPANION_SERVER` nell'ambiente vincono sulla config; `CICCIO_COMPANION_HOME` sposta la cartella `~/.ciccio-companion` (per le prove).

### Server «file»: copiare file tra cartelle consentite

Server MCP **integrato nel companion** (nessun processo né pacchetto da installare, funziona anche nell'.exe). Serve quando uno strumento legge e scrive solo in certe cartelle (Affinity via script: solo sotto il Desktop) ma i file stanno altrove (OneDrive): l'agente copia di qua e di là. **Spento finché nella config non c'è la voce.** Le cartelle le chiede l'agente (`chiedi_accesso`) e le consente chi è davanti al PC: la voce può partire con `"roots": []`, e finché è vuota gli strumenti rispondono «nessuna cartella consentita ancora: chiedila con chiedi_accesso».

```json
"file": {
  "type": "builtin",
  "builtin": "file",
  "roots": [
    { "path": "%USERPROFILE%\\OneDrive - Acme s.r.l\\ACME SRL", "solaLettura": true },
    "%USERPROFILE%\\Desktop\\lavoro",
    { "path": "%USERPROFILE%\\OneDrive - Acme s.r.l\\ACME SRL\\Documenti\\Schede", "backup": "_archivio/precedenti" }
  ]
}
```

- `roots`: le cartelle consentite (anche nessuna: `[]`), come stringa o come `{ "path", "backup", "solaLettura" }`. `~` e `%VARIABILE%` si espandono come negli altri percorsi della config. La cartella può non esistere ancora (la crea `crea_cartella`).
- `solaLettura: true`: da lì si elenca e si copia **verso** le altre cartelle, ma dentro non si scrive niente (`copia` con destinazione lì e `crea_cartella` danno errore, con l'elenco delle cartelle scrivibili). Una cartella consentita dentro un'altra vince sulla più grande: sopra, tutta `ACME SRL` è in sola lettura tranne `Schede`, scrivibile e con il backup. Con `solaLettura` non c'è `backup`.
- `backup` (facoltativo, relativo alla root, senza `..`): quando `copia` sovrascrive qualcosa in quella root, la versione esistente viene prima copiata lì con lo **stesso percorso relativo** alla root (`<root>/Cat/PDF/x.pdf` → `<root>/<backup>/Cat/PDF/x.pdf`). Se nel backup c'è già una copia, resta la più vecchia (la versione prima dei nostri interventi). Scrivere dentro la cartella di backup non genera altri backup.
- `allow`/`deny`/`disabled` valgono come per gli altri server (`"deny": ["chiedi_accesso"]` toglie le richieste di accesso).
- Istruzioni del server e descrizioni di `copia` e `crea_cartella` dicono agli agenti quali cartelle sono in sola lettura; si aggiornano da sole quando ne arriva una nuova.
- Strumenti (compaiono come `mcp__pc_<nome>__file_<strumento>`):

| Strumento | Cosa fa |
|---|---|
| `elenca` | contenuto di una cartella (nome, tipo, dimensione, data di modifica); `ricorsivo`, `limite` (default 200, max 5000); senza percorso mostra le cartelle consentite (con `solaLettura` e le scadenze di quelle «questa volta») |
| `info` | esiste? tipo, dimensione, data di modifica |
| `copia` | `da` → `a` (percorso completo della copia, in una cartella scrivibile), file o cartella (ricorsivo), crea le cartelle di destinazione; se `a` esiste: errore, salvo `sovrascrivi: true` (con backup se la root lo prevede). Copia in un file temporaneo e rinomina, così nessuno vede un file a metà |
| `crea_cartella` | crea la cartella con le intermedie, in una cartella scrivibile |
| `chiedi_accesso` | `cartella`, `solaLettura`, `motivo`: chiede sul PC di consentire una cartella nuova (o di scrivere in una in sola lettura). Solo Windows e Mac, vedi sotto |
| `scarica_da_ciccio` | `file_sul_server` (relativo alla radice del repo del progetto), `destinazione` (percorso completo sul PC, in una cartella scrivibile), `sovrascrivi`: porta sul PC un file fatto da un agente sul server (es. l'STL di OpenSCAD). Vedi [File tra Ciccio e il PC](#file-tra-ciccio-e-il-pc) |
| `carica_su_ciccio` | `file_sul_pc` (in una cartella consentita, anche in sola lettura), `destinazione_sul_server` (relativa al repo), `sovrascrivi`: il verso opposto |

Niente cancellazioni, niente comandi, niente lettura del contenuto dei file da parte dell'agente.

**Richiesta di accesso (`chiedi_accesso`).** Così una cartella nuova non richiede di modificare la config a mano. Sul PC compare una finestra «Un agente chiede una cartella» con la cartella (percorso reale), il tipo di accesso e il motivo scritto dall'agente, e tre pulsanti:

- **Consenti questa volta**: vale subito, finché il companion resta acceso e al massimo 8 ore; la config non cambia.
- **Consenti sempre**: la cartella si aggiunge a `roots` in `config.json` (se c'è già, ne cambia solo l'accesso; il resto della config resta com'è, il file nuovo si controlla prima di sostituire il vecchio) e vale subito, senza riavviare il companion.
- **No**: l'agente riceve «rifiutata» e la stessa cartella per 10 minuti si rifiuta da sola, senza altre finestre.

Su Windows la casella **«Solo lettura»** parte com'è stata chiesta e si può cambiare prima di scegliere (si può concedere meno, o più, di quanto chiesto). Senza risposta entro **3 minuti** la finestra si chiude e l'agente riceve «nessuna risposta» (niente accesso); si chiude anche se la chiamata viene annullata da Ciccio. Una richiesta alla volta.

La decisione resta sul PC: Ciccio e gli agenti possono solo chiedere, non c'è nessun comando dal server che allarghi le cartelle. Non si possono chiedere la radice di un disco né cartelle che contengono la cartella del companion (`~/.ciccio-companion`, con il token: con la scrittura lì un agente potrebbe allargarsi le cartelle da solo); quella cartella non è raggiungibile nemmeno se una root della config la contiene. La finestra compare in primo piano anche mentre si sta scrivendo altrove: da tastiera (Invio, Esc, spazio, Tab) si può solo dire **No**, e i due «Consenti» si premono col mouse, attivi dopo un secondo. Richieste e risposte finiscono nel registro (`accesso · …`).

- **Windows**: finestra di PowerShell come le altre del companion (anche con il companion acceso da terminale).
- **Mac**: finestra di `osascript` (display dialog) con gli stessi tre pulsanti e «No» predefinito, ma senza la casella: vale il tipo di accesso chiesto dall'agente. **Non ancora provata su un Mac.**
- Altrove lo strumento non c'è.

**Sicurezza.** Ogni percorso, di origine e di destinazione, si risolve con `realpath` (del tratto che esiste) e deve stare dentro una root; altrimenti errore con l'elenco delle cartelle consentite. Quindi `..`, collegamenti simbolici e junction di Windows che portano fuori sono rifiutati; il confronto ignora le maiuscole su Windows; flussi alternativi NTFS (`file.txt:flusso`) e percorsi relativi sono rifiutati. Anche la sola lettura vale dopo `realpath`: una junction in una cartella scrivibile che porta in una in sola lettura non permette di scriverci. I collegamenti non si seguono né nell'elenco né nella copia di una cartella (sono saltati e contati in `collegamentiSaltati`). Prima di scrivere, `copia` controlla tutto l'albero di destinazione (e quello del backup): se dove scriverebbe c'è un collegamento non scrive niente. Le root si risolvono a ogni chiamata. Non è protetto da una sostituzione di cartelle in contemporanea durante la copia (verifica e uso non sono atomici): le root vanno scelte in cartelle dell'utente.

Prova: `pnpm exec tsx companion/test/file.ts` e `bun companion/test/file.ts` (entrambi nella CI Windows: l'.exe gira su Bun; `chiedi_accesso` con una finta finestra). La finestra vera, su un desktop Windows acceso: `pnpm exec tsx companion/test/access-windows.ts <exe> [--attesa]` (le finestre compaiono e si cliccano da sole col mouse: non toccarle; `--attesa` aspetta anche i 3 minuti senza risposta).

### File tra Ciccio e il PC

`scarica_da_ciccio` e `carica_su_ciccio` del server `file` scambiano un file tra il **repo del progetto dell'agente che chiama** e le cartelle consentite del PC. Un agente produce sul server un `.stl`, lo porta sul Desktop, lo affetta con Bambu Studio (server `comandi`) e riporta il `.3mf` nel repo.

- **Ciccio** controlla il percorso nel repo: `realpath` dentro la radice del repo del progetto (né `..` né collegamenti che portano fuori, né altri progetti), mai dentro `.git`, al massimo 200 MB; per il download calcola dimensione e sha256. Poi prepara un **token monouso** (5 minuti, legato a quel PC e a quel file) e lo passa al companion con la chiamata, fuori dagli argomenti dell'agente. Le sessioni senza progetto (Ciccio stesso) non scambiano file.
- **Il companion** controlla la sua parte con le regole di sempre: destinazione in una cartella scrivibile (né sopra un collegamento, né sopra un file che c'è già senza `sovrascrivi`, con il backup della root se c'è), origine in una cartella consentita. Poi scarica o carica con il token del dispositivo su `/companion/transfer/<token>` del server della sua config (da Ciccio prende solo il token, mai un indirizzo), in un file temporaneo che rinomina alla fine: dimensione e sha256 si confrontano nei due versi, un trasferimento caduto a metà non lascia niente.
- Il token vale una volta, solo per quel PC (un altro dispositivo riceve 404) e solo nel verso preparato. Solo gli strumenti integrati possono dichiararsi trasferimenti: a un server MCP esterno non arrivano né il segno né il token.
- Sono azioni (`readOnlyHint: false`): in Auto chiedono all'utente. `"deny": ["scarica_da_ciccio", "carica_su_ciccio"]` nella voce `file` li toglie.

### Server «comandi»: programmi a riga di comando consentiti

Server integrato per i programmi a riga di comando del PC, **senza «esegui un comando qualsiasi»**: ogni voce ha programma e argomenti fissi, e l'agente sceglie solo i valori dei segnaposto. Ogni voce diventa uno strumento `mcp__pc_<nome>__comandi_<voce>` con il suo schema. Esempio, lo slicer di Bambu Studio per la P1S (provato su Windows: un cubo di 20 mm in mezzo secondo, 3MF con il G-code):

```json
"comandi": {
  "type": "builtin",
  "builtin": "comandi",
  "comandi": {
    "bambu_slice": {
      "descrizione": "Affetta un modello per la Bambu Lab P1S (0.4, 0.20 mm Standard, PLA Basic) e salva il 3MF con il G-code.",
      "programma": "C:\\Program Files\\Bambu Studio\\bambu-studio.exe",
      "argomenti": [
        "--load-settings", "C:\\Program Files\\Bambu Studio\\resources\\profiles\\BBL\\machine\\Bambu Lab P1S 0.4 nozzle.json;C:\\Program Files\\Bambu Studio\\resources\\profiles\\BBL\\process\\0.20mm Standard @BBL X1C.json",
        "--load-filaments", "C:\\Program Files\\Bambu Studio\\resources\\profiles\\BBL\\filament\\Bambu PLA Basic @BBL X1C.json",
        "--slice", "0", "--export-3mf", "{uscita}", "{modello}"
      ],
      "parametri": {
        "modello": { "tipo": "file", "estensioni": [".stl", ".3mf", ".obj", ".step"] },
        "uscita": { "tipo": "uscita", "estensioni": [".3mf"] }
      },
      "timeout": 600,
      "cartella": "%TEMP%"
    }
  }
}
```

- `programma`: percorso assoluto (con `~` e `%VARIABILE%`); su Windows solo `.exe` o `.com` (un `.bat` o `.cmd` passerebbe da `cmd.exe`).
- `argomenti`: in ordine; `{nome}` è un parametro, `{{` e `}}` sono graffe vere. Ogni segnaposto deve essere tra i `parametri` e ogni parametro negli argomenti.
- `parametri` (`descrizione` facoltativa per tutti): `file` = un file che esiste in una cartella consentita del server `file` (anche in sola lettura), con `estensioni`; `uscita` = un percorso in una cartella **scrivibile** del server `file` (cartelle create, backup della root se c'è; se il file c'è già errore, salvo `"sovrascrivi": true`); `numero` con `min`, `max`, `intero`, `predefinito`; `testo` solo tra i `valori` ammessi (`predefinito`). I percorsi si controllano con le stesse regole del server `file` (`realpath`, junction, sola lettura): serve la voce `file`.
- `timeout` in secondi (default 300, poi si chiude tutto l'albero dei processi), `cartella` di lavoro (default la cartella temporanea; Bambu Studio ci lascia `result.json`).
- Si lancia **senza shell** (`spawn` con l'elenco degli argomenti, `windowsHide`): un valore con spazi, `&` o `;` resta un argomento solo. Torna all'agente codice d'uscita, durata, se le uscite ci sono (con la dimensione) e la fine di stdout e stderr (6000 caratteri ciascuno). Un comando alla volta per voce.
- I comandi sono azioni (`readOnlyHint: false`): in Auto chiedono all'utente qualunque sia il nome.
- Bambu Studio: senza `--load-settings` e `--load-filaments` va in crash (codice 3221225477); con i profili di sistema funziona. È un programma con finestra, quindi stdout resta vuoto: l'esito è nel codice d'uscita e in `result.json`.

### Strumenti proposti dagli agenti

Nel server `comandi` ci sono anche due strumenti per chiedere, non per fare:

- **`proponi_comando`** (`nome`, `descrizione`, `programma`, `argomenti`, `parametri`, `timeout`, `cartella`, `motivo`): una voce nuova come sopra. La finestra «Un agente propone un comando» mostra il programma (percorso vero), gli argomenti esatti uno per riga, cosa può scegliere l'agente per ogni segnaposto, cartella, tempo massimo e motivo; avvisa se il programma è un interprete (cmd, PowerShell, Python, Node…). Con «Consenti sempre» la voce va nella config e lo strumento c'è subito (`tools/list_changed`, niente riavvio).
- **`proponi_strumento`** (`nome`, `tipo` `comando` o `url`, `comando`, `argomenti`, `env`, `url`, `trasporto`, `intestazioni`, `motivo`): un server MCP locale nuovo. La finestra «Un agente propone uno strumento» mostra il **comando esatto** che verrà eseguito (e il percorso vero se è un nome nel PATH, es. `npx = C:\Program Files\nodejs\npx.cmd`), le variabili d'ambiente, avvisa se un pacchetto `npx`/`uvx` non ha la versione fissata, e dice se ci sono chiavi: solo come riferimenti a 1Password. Con «Consenti sempre» il server va nella config, parte subito e l'agente riceve se è partito e quanti strumenti ha. Gli indirizzi solo su questo PC (`localhost`, `127.0.0.1`, `[::1]`).

Le regole delle due proposte:

- **Mai chiavi in chiaro**: un valore in `env` o `intestazioni` che sembra una chiave (prefissi noti come `sk-`, `ghp_`, `xox…`, JWT, chiavi private, lunghe sequenze casuali) o il cui nome lo fa pensare (`*KEY*`, `*TOKEN*`, `*SECRET*`, `Authorization`…) deve essere un riferimento `op://…`; negli argomenti niente chiavi né opzioni come `--api-key`, e niente riferimenti (vanno in `env`). Una proposta così si rifiuta senza finestra, con la spiegazione all'agente.
- Niente a capo, caratteri di controllo o di inversione del testo in nomi, argomenti e percorsi: potrebbero far sembrare la finestra diversa da quello che si esegue.
- Il programma deve esistere sul PC; un nome già usato si rifiuta (per cambiare una voce si modifica la config a mano).
- Come per `chiedi_accesso`: una richiesta alla volta, 3 minuti poi «nessuna risposta», chiusa se Ciccio annulla la chiamata, «No» rifiuta la stessa proposta per 10 minuti, da tastiera solo «No» e «Consenti sempre» col mouse dopo un secondo. Su Mac la stessa finestra con `osascript` (**non ancora provata su un Mac**).

Prove: `pnpm exec tsx companion/test/comandi.ts` e `bun companion/test/comandi.ts` (comandi, proposte con una finta finestra, `op://`, ricarica della config), `pnpm exec tsx companion/test/migrazioni.ts` e `bun companion/test/migrazioni.ts` (`comandi` e `file` aggiunti una volta sola alle config vecchie, `file` senza cartelle e «Consenti sempre» nell'elenco vuoto, ricarica dopo un rename da fuori, che con Bun su macOS arriva solo col nome del file temporaneo), `pnpm exec tsx companion/test/transfer.ts` (scarica e carica con il server di Ciccio vero nello stesso processo). Sul desktop di Windows, con le finestre vere cliccate col mouse: `pnpm exec tsx companion/test/comandi-windows.ts <exe> [--foto <cartella>]` (STL dal repo al Desktop, proponi_comando di Bambu Studio — o `certutil` se Bambu non c'è —, 3MF affettato e riportato nel repo, proponi_strumento di un server di prova che parte senza riavvii, tastiera → No, config cambiata a mano).

### 1Password: chiavi SSH e segreti, con il consenso del PC

Gli agenti usano le chiavi SSH di 1Password (ssh, scp, git) e leggono segreti `op://…` (`usa_credenziale`) attraverso il companion del PC scelto in Impostazioni › Credenziali. In Ciccio l'utente approva la firma SSH (vale 15 minuti per chat) e ogni uso di un segreto; ma un server compromesso potrebbe inventarsi l'approvazione, quindi decide di nuovo il PC (`companion/src/consensi.ts`), prima di passare la richiesta a 1Password:

- **Segreti**: finestra «Ciccio chiede un segreto di 1Password» con il riferimento `op://…` esatto e il motivo scritto dall'agente (solo informativo). «Consenti questa volta», «Consenti sempre» (il riferimento va in `onePassword.segreti` nella config del PC e da lì in poi passa senza finestra) o «No». Poi 1Password chiede Touch ID o Windows Hello, se è impostato così.
- **SSH**: il PC firma solo richieste di accesso SSH (dati che sono un `SSH_MSG_USERAUTH_REQUEST` con metodo `publickey` per la stessa chiave): niente firme di commit (`SSHSIG`), file o token, anche se Ciccio le chiedesse. La finestra «Ciccio chiede una firma SSH» dice l'utente e il server. Il server è **verificato** se la sua chiave è firmata nella richiesta stessa (metodo `publickey-hostbound-v00@openssh.com`) o nel messaggio `session-bind@openssh.com` che ssh manda all'agent dopo lo scambio di chiavi (Ciccio lo tiene per quel collegamento e lo gira al PC in `bind`; il PC controlla che la chiave del server abbia firmato proprio quella sessione: ed25519, RSA con sha2, ECDSA), e il nome viene da `~/.ssh/known_hosts` del PC (una riga `@revoked` blocca). Con il server verificato: «Consenti per 15 minuti» (quell'utente su quel server), «Consenti sempre» (`utente@server` in `onePassword.ssh`) o «No»; con il server non in known_hosts la finestra mostra l'impronta della sua chiave, senza un server noto solo «Consenti questa volta» o «No».
- Una richiesta alla volta; senza risposta (2 minuti per i segreti, 90 secondi per SSH, perché il server remoto chiude il collegamento dopo 2 minuti) è no; dopo un «No» la stessa richiesta si rifiuta da sola per 10 minuti; da tastiera solo «No», i consensi col mouse. Dove non c'è una finestra (Linux) passa solo quello che è già nella config. Nel registro del companion va cosa è stato chiesto e deciso, mai il valore.

```json
"onePassword": {
  "segreti": ["op://Lavoro/Servizio/credential"],
  "ssh": ["git@github.com"]
}
```

### Permessi e notifiche (Mac)

Alla prima apertura l'app mostra **Permessi di Ciccio Companion** (si riapre dal menu, «Permessi…»): per ogni voce lo stato e un pulsante che apre il punto esatto delle Impostazioni di Sistema.

- **Notifiche**: gli avvisi di Ciccio (giro finito, permesso richiesto, agente bloccato) arrivano come notifiche del Mac con l'icona di Ciccio, anche a browser chiuso; al clic si apre la chat dell'agente. La prima volta il pulsante fa comparire la domanda di macOS, dopo un rifiuto apre Notifiche › Ciccio Companion.
- **Avvio in background**: Generali › Elementi di login ed estensioni › Consenti in background. Senza, il companion non si accende da solo all'accesso.

Affinity (localhost) e Chrome non chiedono altri permessi. Chrome sul Mac il companion non lo lancia come suo processo figlio: lo apre come un'app normale (`open`, profilo dedicato, porta di debug 9333 solo su 127.0.0.1) e chrome-devtools-mcp ci si collega con `--browserUrl`. Così macOS non chiede «Gestione app» né «Dati di altre app» per Ciccio Companion (li chiedeva per quello che fa Chrome all'avvio, e di nuovo dopo ogni aggiornamento) e Chrome resta aperto anche quando il companion si riavvia. Le config con `--userDataDir` si convertono da sole. Le notifiche si spengono dal menu, «Notifiche di Ciccio» (`notifications` in `config.json`); con le notifiche del companion attive Ciccio non le manda anche dal browser.

### Aggiornamento automatico

Niente di complicato: si pubblica una versione firmata e i PC accesi se la prendono da soli.

1. Alza `VERSION` in `companion/src/config.ts` (e `version` in `package.json`, che dà il nome al tag).
2. Tag `vX.Y.Z`: la [release firmata](#firma-delle-release) compila Mac e Windows, scrive `companion.json` e firma tutto.
3. Sul server, come l'utente di Ciccio: `bash deploy/fetch-release.sh` controlla le firme e mette i file in `~/.ciccio/downloads`.

Senza GitHub, dal Mac: `CICCIO_RELEASE_KEY_FILE=<chiave privata> DEST=utente@server:.ciccio/downloads pnpm companion:publish` compila, scrive e firma `companion.json` allo stesso modo e copia tutto sul server (`SKIP_BUILD=1` per usare i file già in `dist/companion`, per esempio l'.exe con icona della CI Windows).

Ciccio dice ai companion con una versione più vecchia che ce n'è una nuova (appena si collegano, appena cambia `companion.json` e poi ogni 10 minuti), mandando il testo esatto di `companion.json` e la sua firma (`companion.json.sig`). Il companion controlla la firma con la chiave pubblica che ha dentro, prende dal manifest firmato (non dal resto del messaggio) il file della sua piattaforma, lo scarica con il suo token da `/companion/download/<file>` (solo i file elencati in `companion.json`), controlla dimensione, sha256 e firma del file e lo installa quando non ci sono chiamate agli strumenti in corso. Con una firma che non torna, un manifest di un altro programma o di un'altra versione, o con il segnaposto al posto della chiave, scrive nel registro perché e non installa niente:

- **Mac**: l'app della barra dei menu scompatta `CiccioCompanion-mac.zip`, si chiude, scambia la cartella in Applicazioni e si riapre (se lo scambio non riesce resta la versione di prima);
- **Windows**: con l'icona (il caso normale) il companion scarica e controlla il file e lo segnala in `status.json`, come sul Mac; l'icona rinomina gli .exe di `bin` in `.old` (Windows permette di rinominare un .exe in uso, non di sovrascriverlo), mette al loro posto la versione nuova (con e senza console), avvia la nuova icona e si chiude con il companion e i suoi server MCP. La nuova icona aspetta che la vecchia sia chiusa, toglie i `.old` e riaccende il companion. Se la nuova non parte entro 20 secondi tornano le copie di prima. Chiave Run, link `ciccio-companion://` e config non cambiano. Senza icona (companion lanciato con `run --background`) fa lo stesso da solo; un .exe lanciato da fuori `bin` (scaricato, non installato) scrive solo nel registro che c'è una versione nuova.

La CI «Companion Windows» prova anche questo (`companion/test/update-windows.ts`): compila due .exe di prova con una chiave usa e getta, installa la versione attuale, pubblica una 9.9.9 firmata con un'altra chiave (rifiutata) e poi con quella giusta, e controlla che il companion si sostituisca, riparta alla 9.9.9 con un altro processo e non lasci copie `.old`.

Prova a mano sul PC Windows: con il companion installato e collegato, metti sul server una versione più alta firmata; entro pochi secondi `.\ciccio-companion.exe status` (in `bin`) mostra un altro PID e nel registro compare «aggiornato alla versione …»; in Ciccio il PC risulta acceso con la versione nuova.

Il companion lanciato da terminale (fuori dall'app del Mac) scrive solo nel registro che c'è una versione nuova.

### Protocollo

WebSocket `/companion` con `Authorization: Bearer <token>`, messaggi JSON-RPC 2.0 (dettagli in `shared/companion.ts`): il companion manda `companion/hello` e `companion/servers` con l'elenco degli strumenti, Ciccio manda `tools/call` e `notifications/cancelled` se la sessione si interrompe, `companion/update` con `manifest` e `signature` (testo di `companion.json` e sua firma), `ssh/agent` con `message` (e `bind`, il session-bind di ssh) e `secret/read` con `ref` (e `motivo`), che il PC conferma nella sua finestra. Ping ogni 30 secondi; il companion si ricollega da solo (attesa crescente fino a 30 secondi, 5 minuti se il token è rifiutato).

### Prova manuale

1. Sul Mac apri Affinity con il server MCP attivo e avvia `ciccio-companion` (deve dire «collegato a ciccio.tuo-tailnet.ts.net come "mac"» e «affinity: 8 strumenti»).
2. In Ciccio apri Impostazioni › Companion: compare `mac` acceso, con `affinity` e i suoi strumenti.
3. Scrivi all'agente: «Elenca gli strumenti di Affinity che hai dal mio PC e leggi l'elenco della documentazione dell'SDK».
4. L'agente risponde con gli strumenti `mcp__pc_mac__affinity_*`; con il livello Manuale ti chiede il permesso per `affinity_list_sdk_documentation`, in Auto lo usa da solo. Nel terminale del companion compaiono `→ affinity · list_sdk_documentation` e `← … ok`.
5. Chiudi il companion: in Impostazioni il PC risulta spento, e dal messaggio successivo l'agente non ha più gli strumenti.

## App desktop

`desktop/`: Ciccio in una finestra sua su Mac (Apple Silicon) e Windows (x64), con le notifiche del sistema. Il Companion resta com'è e serve ancora per gli strumenti del PC; l'app è solo finestra e notifiche.

- **Finestra**: la web app del server, dall'indirizzo scritto al primo avvio. Icona nel Dock o nella barra di Windows, si apre da Spotlight o dal menu Start, ricorda dimensione e posizione, una sola copia (il secondo avvio porta davanti quella aperta). Chiudere la finestra la nasconde: l'app resta accesa per le notifiche (Dock sul Mac, icona nell'area di notifica su Windows). La prima volta si imposta per aprirsi all'accesso, in background (menu Ciccio › «Apri all'accesso», su Windows nel menu dell'icona).
- **Notifiche**: gli stessi avvisi di Ciccio del Companion. Per i permessi degli agenti e le domande con due risposte brevi (sì/no) ci sono due pulsanti, **Consenti** e **Rifiuta** (o le due risposte): la decisione va a Ciccio senza aprire la finestra. Niente «Consenti sempre» dalla notifica, quello resta in chat; le approvazioni che solo l'utente può dare (chiavi SSH, segreti di 1Password, programmi di sistema…) si danno anche da qui. Deciso altrove, la notifica sparisce. Il clic porta la finestra già aperta sulla chat (`/agente/<progetto>/<chat>`), senza ricaricare la pagina.
- **Niente notifiche doppie**: l'app manda a Ciccio lo sha256 del token del Companion dello stesso PC (letto da `~/.ciccio-companion/config.json`; il server ha già quell'hash). Finché l'app è collegata, Ciccio non manda le notifiche a quel Companion; con l'app chiusa tornano al Companion. Con l'app accesa il browser non mostra le sue.
- **Aggiornamento automatico** come il Companion, solo da release firmate, quando la finestra è chiusa o ridotta (o all'uscita): mai mentre scrivi.

### Accesso senza passkey nella finestra

Le passkey nelle WebView di sistema non funzionano senza firma Apple: WKWebView vuole gli *associated domains* (`webcredentials:`), che chiedono un'app firmata con un account sviluppatore e un file sul server; l'app è firmata ad-hoc come il Companion. L'app quindi non usa la passkey:

1. **Collegamento, una volta sola.** Al primo avvio l'app chiede l'indirizzo di Ciccio (https; lo controlla con `/api/auth/state` e lo salva in `config.json`). Poi, da qualunque rete, mostra un codice di 8 caratteri e il pulsante «Apri Ciccio nel browser», che apre Impostazioni › App nel browser di sistema (dove la passkey funziona): scrivi il codice e «Collega», l'app riceve il token entro 2 secondi. Il codice non si passa nell'indirizzo, così un link con il codice di un'altra app non può farla collegare con un clic.
2. **Token nel Portachiavi** del Mac o nell'archivio credenziali di Windows (Gestione credenziali), mai su file. Sul server solo il suo sha256, come per il Companion.
3. **Finestra**: a ogni avvio l'app chiede con il token un codice monouso (2 minuti) e apre `/desktop/login?code=…`, che crea una sessione con un cookie senza scadenza su disco (resta in memoria finché l'app è aperta). Se la sessione scade a finestra aperta, la pagina di accesso lo vede e l'app la rifà da sola.

Scollegare l'app (Impostazioni › App › «Scollega») toglie il token: l'app chiusa resta scollegata, quella aperta torna al collegamento.

### Installazione

- **Mac**: Impostazioni › App › «Scarica per Mac» (`Ciccio-mac.dmg`), trascina Ciccio in Applicazioni e aprila. La prima volta macOS la blocca perché non è firmata da Apple: Impostazioni di Sistema › Privacy e sicurezza › «Apri comunque». Poi chiede le notifiche: «Consenti». Per vedere sempre i pulsanti conviene lo stile «Avvisi» in Impostazioni di Sistema › Notifiche › Ciccio (con «Striscioni» i pulsanti compaiono passandoci sopra).
- **Windows**: «Scarica per Windows» (`Ciccio-windows-setup.exe`), doppio clic: si installa nella cartella utente (`%LOCALAPPDATA%\Ciccio`), senza amministratore, con il collegamento nel menu Start. SmartScreen: «Ulteriori informazioni» › «Esegui comunque». Serve WebView2, che c'è già su Windows 10 e 11 (altrimenti l'installer lo scarica).

Dove stanno le cose: `config.json` con l'indirizzo (`server`; un vecchio `tailnet` viene ignorato) in `~/Library/Application Support/it.costa.ciccio` sul Mac e `%APPDATA%\it.costa.ciccio` su Windows; il token nel Portachiavi (servizio `it.costa.ciccio`). Nessuna telemetria, nessun servizio di terzi: l'app parla solo con Ciccio.

Limite noto sul Mac: l'app è firmata ad-hoc, quindi dopo ogni aggiornamento macOS chiede una volta la password per il Portachiavi («Ciccio vuole utilizzare i dati riservati…»): «Consenti sempre». Rifiutando l'app si ricollega da capo.

### Compilare e pubblicare

Serve Rust (rustup) e Node (la CLI di Tauri si prende con `npx` alla versione fissata in `desktop/build.sh`).

```bash
pnpm desktop:build     # sul Mac: dist/desktop/Ciccio.app, Ciccio-mac.dmg, Ciccio-mac.zip
```

L'installer Windows lo compila la CI «App desktop» (`.github/workflows/desktop.yml`), che lo installa in silenzio, lo avvia e controlla istanza singola, indirizzo `ciccio-app://` e identità delle notifiche; lo stesso `bash desktop/build.sh` funziona anche su Windows (Git Bash).

Per pubblicare una versione: alza `version` in `desktop/src-tauri/Cargo.toml` e fai la [release firmata](#firma-delle-release) (tag `vX.Y.Z`), poi sul server `bash deploy/fetch-release.sh`. Senza GitHub: metti l'installer della CI in `dist/desktop/Ciccio-windows-setup.exe`, poi dal Mac `CICCIO_RELEASE_KEY_FILE=<chiave privata> DEST=… pnpm desktop:publish`, che scrive e firma `app.json` allo stesso modo (`SKIP_BUILD=1` come per il Companion). Le app collegate lo scoprono subito o entro 10 minuti, con il testo di `app.json` e la sua firma: controllano la firma con la chiave pubblica che hanno dentro (`desktop/src-tauri/src/update.rs` legge `shared/release-key.ts` con `include_str!`; verifica con `ed25519-dalek`), scaricano con il loro token da `/desktop/download/<file>` il file che dice il manifest firmato, controllano dimensione, sha256 e firma e si aggiornano: sul Mac si scambia Ciccio.app e si riapre (se lo scambio non riesce resta quella di prima), su Windows l'installer in silenzio e poi si riapre. Senza firma valida, o con il segnaposto al posto della chiave, non si aggiornano (lo scrivono nel registro). `cargo test` in `desktop/src-tauri` prova la lettura delle chiavi e i controlli del manifest con una firma fatta da Node.

### Protocollo

WebSocket `/desktop` con `Authorization: Bearer <token>`, JSON-RPC 2.0 (dettagli in `shared/desktop.ts`): l'app manda `desktop/hello` e `desktop/decide { approvalId, allow }`; Ciccio manda `desktop/notify` (con `approval` per i pulsanti), `desktop/resolved`, `desktop/update`, `desktop/ping`. Le rotte `/desktop/*` sono fuori da `/api`: entrano solo con il token dell'app (o il codice monouso della finestra), mai con i cookie.

### Prove

- `pnpm exec tsx desktop/test/notifiche-doppie.ts` (con `CICCIO_PORT`, `CICCIO_PROJECTS_DIR` con almeno un repo e `CICCIO_DATA_DIR` vuota): app e companion dello stesso PC collegati, la notifica va solo all'app; app spenta, torna al companion.
- `pnpm exec tsx desktop/test/permesso-finto.ts`: server locale vero, aspetta l'app (con `config.json` puntato al server locale, o `CICCIO_APP_SERVER` nell'ambiente dell'app), chiede un permesso e una domanda sì/no come un agente e stampa cosa hai deciso dalla notifica; poi un avviso il cui clic deve aprire la chat nella finestra. Nessun modello coinvolto.

## Firma delle release

Companion e app desktop si aggiornano dal server di Ciccio, ma il server non basta a far installare niente: ogni file e ogni manifest sono firmati con una chiave Ed25519 che sta solo nei segreti delle GitHub Actions, e i programmi controllano la firma con la chiave pubblica che hanno dentro.

```
tag vX.Y.Z ─▶ release.yml: compila e prova (companion-mac, companion-windows, desktop)
                           firma con CICCIO_RELEASE_KEY ─▶ GitHub Release
server:  deploy/fetch-release.sh ─▶ controlla le firme ─▶ ~/.ciccio/downloads
PC:      companion/update, desktop/update (manifest + firma) ─▶ controlla le firme ─▶ installa
```

### Chiavi e formato

- **Chiave privata**: Ed25519 in PEM PKCS#8 (il blocco che stampa `node scripts/release-key.mjs genera`), solo nel segreto del repo `CICCIO_RELEASE_KEY` (e in una copia di riserva fuori da GitHub). Non va mai in un file del repo.
- **Chiave pubblica**: i 32 byte in base64, in `shared/release-key.ts`, una riga tra apici per chiave. È l'unica fonte: il companion la importa (compilata dentro l'.exe e l'app del Mac da Bun), l'app desktop la legge con `include_str!` in `update.rs`, `scripts/release-key.mjs` la legge dal file. Finché c'è il segnaposto, companion e app compilati da quel codice rifiutano ogni aggiornamento automatico e lo scrivono nel registro; anche il workflow di release e `fetch-release.sh` si fermano.
- **Firme**: Ed25519 dei byte esatti, in base64 su una riga. `<file>.sig` per ogni file della release; `companion.json.sig` e `app.json.sig` per i manifest.
- **Manifest** (`companion.json`, `app.json`):

```json
{
  "product": "companion",
  "version": "0.8.0",
  "files": {
    "darwin-arm64": { "file": "CiccioCompanion-mac.zip", "sha256": "…", "size": 123, "sig": "…" },
    "win32-x64": { "file": "CiccioCompanion-windows.exe", "sha256": "…", "size": 123, "sig": "…" }
  },
  "installers": {
    "darwin-arm64": { "file": "CiccioCompanion-mac.dmg", "sha256": "…", "size": 123, "sig": "…" },
    "win32-x64": { "file": "CiccioCompanion-windows.exe", "sha256": "…", "size": 123, "sig": "…" }
  }
}
```

  `files` sono gli aggiornamenti automatici, `installers` i file della prima installazione (i .dmg, l'.exe, l'installer dell'app); `sig` è la firma del file. L'app ha `"product": "app"` con `Ciccio-mac.zip`, `Ciccio-mac.dmg` e `Ciccio-windows-setup.exe`. Chi aggiorna controlla: firma del manifest, `product` giusto, versione uguale a quella offerta (e più nuova della sua), il file della sua piattaforma preso dal manifest firmato, poi dimensione, sha256 e firma del file scaricato. Una versione vecchia firmata non passa (deve essere più nuova), un manifest del companion non vale per l'app.
- **Sul server** `downloads` ha i file, le loro `.sig`, i manifest e le loro firme. Ciccio manda ai programmi il testo esatto del manifest e la sua firma (`server/src/releases.ts`); `/download/<file>` serve anche le `.sig` e i manifest, per chi vuole controllarli a mano.

`scripts/release-key.mjs` (Node, senza dipendenze) fa tutto il resto: `genera`, `chiave-pubblica` (dalla privata in `CICCIO_RELEASE_KEY` o `CICCIO_RELEASE_KEY_FILE`), `manifest <companion|app> <versione> <cartella> piattaforma=file… --installer piattaforma=file…` (scrive manifest e firme), `firma <file>…`, `verifica <cartella>` (con le chiavi di `shared/release-key.ts`, o `--chiave-pubblica`), `chiavi-del-repo`.

### Prima volta (proprietario del repo)

1. `node scripts/release-key.mjs genera` su un PC fidato: stampa la chiave pubblica e la privata, con le istruzioni.
2. La pubblica al posto del segnaposto in `shared/release-key.ts`, poi commit (i programmi compilati da lì in poi accettano solo quella).
3. La privata nel segreto del repo: GitHub › Settings › Secrets and variables › Actions › New repository secret, nome `CICCIO_RELEASE_KEY`, valore il blocco PEM intero (o `gh secret set CICCIO_RELEASE_KEY < file`, poi cancella il file). Una copia di riserva in un posto sicuro (per esempio 1Password).
4. Alza `version` in `package.json` (e le versioni di companion e app, se cambiano), commit, `git tag vX.Y.Z` e push del tag. Il workflow «Release» si ferma subito se manca il segreto, se c'è ancora il segnaposto o se il tag non è `v` + `version` di `package.json`; prima di pubblicare controlla che la privata corrisponda alla pubblica del repo e ricontrolla tutte le firme. La release esce prima come bozza e diventa pubblica solo con tutti i file.
5. Sul server: `bash deploy/fetch-release.sh` (o `CICCIO_FETCH_RELEASE=1 bash deploy/install.sh`).

I companion e le app installati prima della chiave (con il segnaposto, o versioni senza firme) non si aggiornano da soli verso le release firmate: la prima volta si installano a mano da Impostazioni › Companion e › App.

### Cambiare chiave

- **Rotazione normale**: genera la chiave nuova, aggiungi la sua pubblica in `shared/release-key.ts` accanto a quella vecchia e fai una release firmata ancora con la vecchia: i programmi aggiornati accettano tutte e due. Poi metti la privata nuova in `CICCIO_RELEASE_KEY`, togli la pubblica vecchia e fai la release successiva (firmata con la nuova).
- **Chiave privata esposta**: togli subito il segreto (niente release nuove) e cambia chiave come sopra, ma senza aspettare: finché i PC hanno la pubblica vecchia, chi ha la privata vecchia potrebbe firmare un aggiornamento per loro se controllasse anche il server. Scrivilo nelle note della release.
- **Chiave privata persa** (senza copia): non si può firmare la release di passaggio. Si mette la pubblica nuova e i PC si aggiornano una volta a mano.

