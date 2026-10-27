# Ciccio

Sala controllo per i tuoi agenti AI, basati su Claude: un agente per ogni progetto (un repo git), una griglia per vederli tutti, Ciccio che riassume la giornata e smista i messaggi all'agente giusto, la voce per usarlo senza tastiera.

Gira sul tuo server e lo apri dal browser, dal telefono o dall'app desktop. Ogni agente lavora solo nel suo repo, in una sandbox, e ti chiede il permesso per quello che conta.

> Ciccio è un progetto indipendente: non è un prodotto di Anthropic né di Claude Code.

## Cosa fa

- **Un agente per progetto.** Ogni repo nella cartella dei progetti ha il suo agente, con chat, diff, file, permessi e la stessa potenza di Claude Code.
- **Chi ti aspetta, prima di tutto.** La griglia mostra chi lavora, chi è fermo e chi aspetta una tua risposta; i permessi arrivano come card, anche nelle notifiche.
- **Ciccio, il responsabile.** Riepilogo del mattino, messaggi passati all'agente giusto, coordinamento tra progetti.
- **Al sicuro per costruzione.** Sandbox dei comandi (bubblewrap), un agente vede solo il suo repo, firewall in uscita con i domini consentiti, programmi di sistema e domini nuovi solo con la tua approvazione.
- **I tuoi PC.** Il companion (Mac e Windows) fa usare agli agenti i programmi del PC acceso (Chrome, Affinity, file, comandi), sempre con i permessi della chat.
- **App desktop** con notifiche e Consenti/Rifiuta dalla notifica; **voce** facoltativa; **routine** a orari fissi.

## Requisiti

- Un server **Ubuntu 24.04** vuoto, anche un VPS da pochi euro: 2 CPU e 4 GB di RAM bastano per qualche agente alla volta (x86_64 o arm64). Ti serve l'accesso come root (o un utente con sudo).
- Un account **[Tailscale](https://tailscale.com)** (gratuito per uso personale), obbligatorio: Ciccio si raggiunge dalla tua tailnet, non direttamente da internet. Tailscale va anche sul telefono e sul PC da cui apri Ciccio.
- Un **abbonamento Claude** a pagamento, uno qualsiasi: Pro, Max, Team o Enterprise. Ciccio e gli agenti lavorano con il tuo account claude.ai, con il login fatto sul server (lo guida `setup.sh`), e ne condividono i limiti di utilizzo. Il piano gratuito non basta: non include Claude Code.
- Un account **GitHub**, se gli agenti devono clonare, fare push e aprire PR.

Il resto (Node 24, git, gh, bubblewrap, socat, il profilo AppArmor della sandbox, Tailscale, ufw) lo installa `setup.sh`.

**Niente chiavi API.** Ciccio non funziona con una chiave API di Anthropic e non va usato così. Fa lavorare gli agenti in modalità agentica: chat lunghe che tengono il contesto da un giro all'altro, con i connettori e le skill del tuo account claude.ai. È costruito e provato solo con il login dell'abbonamento; con una chiave API il contesto si perderebbe e niente di tutto questo è stato provato. Per questo, se nell'ambiente del server c'è `ANTHROPIC_API_KEY` (o un altro accesso a consumo: `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex, Foundry), Ciccio non lo passa alle sessioni.

**Non tutto è open source.** Ciccio funziona solo con il [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`), che è software proprietario di Anthropic con le sue [condizioni commerciali](https://www.anthropic.com/legal/commercial-terms); con l'installazione arriva anche il programma di Claude Code, che l'SDK lancia. SDK, Claude Code e API di Anthropic non sono coperti dalla licenza di Ciccio. Dettagli in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Installazione

Come root sul server (o con `sudo`), una volta sola:

```bash
apt-get install -y git
git clone https://github.com/danielecosta7/ciccio ciccio-setup
bash ciccio-setup/deploy/setup.sh
```

`setup.sh` è una procedura guidata: per ogni passo controlla com'è il server, spiega in una riga cosa sta per fare, chiede (Invio accetta la risposta proposta), lo fa e verifica che funzioni. Si può interrompere e rilanciare quando vuoi: i passi già a posto si saltano. `--check` mostra solo lo stato, `--step NOME` rifà un passo, `--yes` accetta tutte le risposte proposte.

| Passo | Cosa fa |
| - | - |
| `sistema` | Controlla Ubuntu 24.04, architettura, RAM. |
| `utente` | Crea l'utente che esegue Ciccio (`ciccio`), senza password né sudo; rifiuta un utente che può usare sudo. |
| `pacchetti` | git, gh, bubblewrap, socat, build-essential, python3-venv, ufw; il profilo AppArmor `/etc/apparmor.d/bwrap` che serve alla sandbox su Ubuntu 24.04. Verifica che la sandbox parta. |
| `node` | Node 24 per l'utente in `~/.local/node`, dal sito di Node, controllato con l'impronta sha256. |
| `tailscale` | Installa Tailscale dal suo repository ufficiale, collega il server (stampa un link da aprire), ti guida ad attivare MagicDNS e HTTPS nella console e pubblica Ciccio sulla tailnet (`tailscale serve`). |
| `linger` | Il servizio dell'utente resta acceso dopo un riavvio, senza nessuno collegato. |
| `repo` | Clona Ciccio in `~ciccio/ciccio`. |
| `copia-root` | Copia in `/usr/local/lib/ciccio` gli script che root esegue: root non esegue mai file che l'utente di Ciccio può modificare. |
| `ciccio` | Il tuo nome, gli indirizzi, il fuso orario, GitHub (`gh auth login` dal browser), nome ed email dei commit; poi compila e avvia (`install.sh`) e fa il login di claude.ai con il tuo abbonamento (un link da aprire nel browser e un codice da incollare). |
| `firewall` | Firewall in uscita: gli agenti raggiungono solo i domini consentiti, da un proxy locale. Accende ufw se è spento (lasciando aperti SSH e Tailscale: lo spiega prima) e verifica che funzioni. |
| `helper` | Facoltativi: domini nuovi su richiesta degli agenti, programmi di sistema su richiesta (solo pacchetti ufficiali di Ubuntu), server SSH dalle Impostazioni. Ognuno chiede sempre la tua approvazione in Ciccio. |
| `schermo` | Facoltativo: schermo virtuale (Xvfb) per i programmi grafici degli agenti. |
| `voce` | Facoltativo: voce sul server (Whisper e Piper), con i modelli scaricati a revisioni fisse e controllati. |
| `dominio` | Facoltativo: Ciccio anche da un tuo dominio, dietro Caddy; stampa la configurazione e aggiunge l'indirizzo. |
| `fine` | Il codice di attivazione e i prossimi passi. |

Alla fine apri `https://<server>.<tailnet>.ts.net` da un dispositivo della tailnet e inserisci il codice di attivazione: crei la passkey (Face ID, Touch ID, impronta o PIN). Gli altri dispositivi li aggiungi da Impostazioni › Accesso; companion e app desktop si collegano da Impostazioni con un codice. Poi, come l'utente di Ciccio (`sudo -iu ciccio`), clona i repo dei tuoi progetti in `~/projects`: ognuno diventa un agente.

**Codice perso** (nessun dispositivo collegato, passkey cancellata): come l'utente di Ciccio, `bash ~/ciccio/deploy/install.sh code` stampa un codice nuovo.

Stato del server in ogni momento: `sudo bash /usr/local/lib/ciccio/setup.sh --check`.

### A mano

Per chi preferisce fare da sé, nell'ordine (dettagli in [docs/tecnico.md](docs/tecnico.md#server)):

1. Come root: un utente senza sudo; `apt-get install git gh bubblewrap socat curl ca-certificates xz-utils build-essential python3 python3-venv ufw`; su Ubuntu 24.04 il profilo AppArmor per bubblewrap ([documentazione della sandbox](https://code.claude.com/docs/en/sandboxing)); Node 24 in `~utente/.local/node`; Tailscale collegato, con MagicDNS e HTTPS attivi nella console; `tailscale serve --bg --https=443 http://127.0.0.1:8787`; `loginctl enable-linger <utente>`.
2. Come l'utente: `git clone https://github.com/danielecosta7/ciccio ~/ciccio && cd ~/ciccio && CICCIO_OWNER_NAME=Giulia bash deploy/install.sh`. Scrive `~/.config/ciccio.env` commentato. Poi il login di claude.ai con il programma di Claude Code che arriva con l'SDK (`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*/…/claude auth login --claudeai`, il percorso esatto è in Configurazione), `systemctl --user restart ciccio`, `gh auth login` e `bash deploy/install.sh code` per il codice di attivazione.
3. Facoltativi, come root: copia gli script di root in `/usr/local/lib/ciccio` (`setup.sh --step copia-root`) e da lì `egress-firewall.sh`, `egress-helper.sh`, `apt-helper.sh`, `ssh-helper.sh`; la voce con `setup.sh --step voce`.

## Aggiornare

Come l'utente di Ciccio:

```bash
cd ~/ciccio && bash deploy/install.sh
```

Scarica il codice nuovo, compila e riavvia; prima aspetta che gli agenti al lavoro finiscano (al massimo 20 minuti, `FORCE=1` per non aspettare) e chi era a metà riprende da solo.

Gli script di root (firewall, helper con sudo) non si aggiornano da soli: se sono cambiati, `install.sh` lo dice alla fine e stampa il comando, `sudo bash /usr/local/lib/ciccio/setup.sh --step copia-root`, che mostra le differenze e chiede prima di installarle.

## Companion e app desktop

Due programmi facoltativi per i tuoi PC (Mac con Apple Silicon e Windows x64): il **companion**, che fa usare agli agenti i programmi del PC acceso, e l'**app desktop**, Ciccio in una finestra con le notifiche. Si scaricano da Ciccio stesso (Impostazioni › Companion e Impostazioni › App), che li prende dalle [release su GitHub](https://github.com/danielecosta7/ciccio/releases).

- **Sul server.** Al primo `install.sh` (cartella `~/.ciccio/downloads` vuota) Ciccio scarica da solo l'ultima release; per prenderne una nuova, come l'utente di Ciccio: `bash ~/ciccio/deploy/fetch-release.sh` (o `… fetch-release.sh 0.2.0` per una versione precisa; `CICCIO_FETCH_RELEASE=1 bash deploy/install.sh` lo fa a ogni aggiornamento). Lo script controlla le firme e mette i file in `~/.ciccio/downloads`; se GitHub non risponde non tocca niente.
- **Firmati.** Ogni release è firmata con una chiave Ed25519 che sta solo nelle GitHub Actions; la chiave pubblica è in [`shared/release-key.ts`](shared/release-key.ts) ed è compilata dentro companion e app. `fetch-release.sh` controlla le firme prima di installare, e companion e app le ricontrollano prima di aggiornarsi: un server compromesso non può far installare ai tuoi PC un programma che non sia di una release firmata.
- **Aggiornamenti automatici.** Quando sul server c'è una versione nuova, companion e app collegati la scaricano da Ciccio e si aggiornano da soli (il companion quando non sta lavorando, l'app quando la finestra è chiusa).
- **Dal sorgente.** Se compili tu (`pnpm companion:build`, `pnpm desktop:build`, vedi [docs/tecnico.md](docs/tecnico.md#companion-dei-pc)) e hai un fork con le tue release, genera la tua chiave con `node scripts/release-key.mjs genera` e mettila in `shared/release-key.ts` al posto di quella di questo repo: altrimenti i tuoi programmi accettano solo le release firmate qui, non le tue.
- **Non firmati da Apple né da Microsoft**: al primo avvio macOS chiede «Apri comunque» (Impostazioni di Sistema › Privacy e sicurezza) e Windows SmartScreen «Esegui comunque».

Per controllare a mano i file scaricati da GitHub: `node scripts/release-key.mjs verifica <cartella>` (con `companion.json`, `app.json`, i file e le loro `.sig`).

## Configurazione

In `~/.config/ciccio.env` (permessi 600), una variabile per riga; dopo una modifica, `systemctl --user restart ciccio`. La prima installazione lo scrive commentato, con i valori di default. Tutte le variabili del server, con il loro default (`server/src/config.ts`):

| Variabile | A cosa serve | Default |
| - | - | - |
| `CICCIO_OWNER_NAME` | Il tuo nome: Ciccio e gli agenti ti chiamano così. Obbligatoria (si cambia anche da Impostazioni). | `Utente` |
| `CICCIO_ORIGINS` | Gli indirizzi https da cui apri Ciccio, separati da virgola; il primo è quello dei link. Obbligatoria. Il vecchio nome `CICCIO_PUBLIC_ORIGIN` vale ancora. | `http://localhost:5173` (sviluppo) |
| `CICCIO_HOST`, `CICCIO_PORT` | Dove ascolta Ciccio: dalla tailnet ci arriva `tailscale serve`. | `127.0.0.1`, `8787` |
| `CICCIO_PROJECTS_DIR` | Cartella con un repo per progetto: ognuno diventa un agente. | `~/projects` |
| `CICCIO_DATA_DIR` | Database e dati di Ciccio (gli agenti non la vedono). | `~/.ciccio` |
| `CICCIO_WEB_DIR` | Interfaccia web compilata. | `dist/web` del repo |
| `CICCIO_TRUST_PROXY` | Proxy di cui fidarsi per l'indirizzo vero del client (`X-Forwarded-For`), separati da virgola: IP, reti o `loopback`. Se Caddy arriva a Ciccio dall'IP Tailscale, metti quell'IP. | `loopback` |
| `CICCIO_SOURCE_URL` | Dove sta il codice sorgente di questo Ciccio: il link «Codice sorgente» nella pagina di accesso e in Impostazioni › Server. | `https://github.com/danielecosta7/ciccio` |
| `CICCIO_MAX_ACTIVE` | Agenti al lavoro insieme; gli altri aspettano in coda. | `5` |
| `CICCIO_AGENT_MODEL`, `CICCIO_MODEL` | Modello degli agenti e di Ciccio. | `claude-opus-5-5` |
| `CICCIO_STALE_DAYS` | Giorni senza attività dopo cui un progetto con lavoro aperto è «fermo». | `7` |
| `CICCIO_RECAP_HOUR` | Ora in cui Ciccio prepara il riepilogo del giorno. | `5` |
| `CICCIO_TZ` | Fuso orario di routine, riepilogo e consumi (es. `Europe/Rome`). | quello del sistema (su un VPS spesso UTC) |
| `CICCIO_SHUTDOWN_GRACE_S` | Secondi lasciati ai giri al lavoro quando il servizio si ferma. | `20` |
| `CICCIO_RESUME_PC_WAIT_S` | Secondi di attesa all'avvio perché tornino i PC collegati prima. | `30` |
| `CICCIO_VOICE_URL` | Servizio voce sul server. | `http://127.0.0.1:8791` |
| `CICCIO_TOOLS_NO_SANDBOX` | `1`: strumenti su misura senza sandbox. Solo per prove fuori da Linux, mai sul server. | – |

Il servizio voce (`deploy/ciccio-voice.service`) ha le sue: `CICCIO_VOICE_HOST` (`127.0.0.1`), `CICCIO_VOICE_PORT` (`8791`), `CICCIO_VOICE_MODELS` (`~/.ciccio/voice-models`), `CICCIO_VOICE_LANG` (`it`), `CICCIO_VOICE_THREADS` (`4`), `CICCIO_VOICE_WHISPER` (`whisper-base`). Quelle del companion e dell'app desktop sono in [docs/tecnico.md](docs/tecnico.md#config).

Un dominio pubblico (per esempio dietro Caddy) è possibile: aggiungilo a `CICCIO_ORIGINS`. Il login resta obbligatorio da qualunque rete.

**Codice sorgente.** Ciccio è AGPL-3.0: chi lo usa dalla rete ha diritto al codice della versione che gira, e il link «Codice sorgente» glielo indica. Se offri ad altri una versione modificata, metti in `CICCIO_SOURCE_URL` l'indirizzo del codice di quella versione.

## Connessioni esterne

Oltre ad Anthropic, Ciccio si collega a internet solo per queste cose. Con il firewall in uscita, l'utente di Ciccio raggiunge solo i domini dell'elenco (`deploy/egress-firewall.sh`) e quelli che approvi tu.

- **Anthropic e claude.ai**: ogni giro degli agenti e di Ciccio, il login dell'abbonamento e i connettori del tuo account. Le sessioni girano con telemetria, segnalazioni di errore e traffico non essenziale di Claude Code spenti.
- **GitHub**: `git` e `gh` degli agenti (clone, push, PR), progetti nuovi e repo da aggiungere, skill installate da un repo, `gh auth login`, aggiornamenti di Ciccio (`git pull`).
- **npm, Node.js, PyPI** (e `registry.yarnpkg.com`, `cdn.sheetjs.com`): i pacchetti che installano gli agenti, le dipendenze di Ciccio a ogni aggiornamento, quelle della voce. Nell'elenco c'è anche `export-download.canva.com`, per i file del connettore Canva.
- **Domini e server che approvi**: quelli chiesti dagli agenti (`consenti_dominio`), i server dell'elenco SSH, i server MCP remoti dei progetti (`proponi_server_mcp`).
- **Voce esterna**, solo se la colleghi in Impostazioni › Voce: OpenAI, ElevenLabs o Deepgram ricevono l'audio di quello che dici e il testo che ti leggono.
- **Visore di Office online**, spento di serie: se lo accendi (Impostazioni; serve un indirizzo pubblico), i server di Microsoft (`view.officeapps.live.com`) scaricano da Ciccio il file da mostrare, con un link valido mezz'ora.
- **Tailscale**: server e dispositivi parlano con i server di coordinamento di Tailscale e, quando non riescono a collegarsi diretti, con i suoi relay (il traffico resta cifrato). `tailscale serve` prende il certificato https.
- **Installazione** (`setup.sh`, come root): archivi di Ubuntu, `nodejs.org` (Node 24), `pkgs.tailscale.com`, GitHub (il codice di Ciccio; `uv` per la voce se manca `python3-venv`), Hugging Face (modelli della voce, se la installi), Let's Encrypt tramite Caddy (se aggiungi un dominio).

Nel browser l'interfaccia parla solo con Ciccio: caratteri e librerie sono inclusi, le immagini di altri siti nelle risposte si caricano solo con un tocco. Il riconoscimento vocale del browser (la voce «del browser») dipende dal browser: Chrome, per esempio, manda l'audio ai server di Google. Companion e app desktop parlano con il tuo Ciccio; il companion avvia i server MCP della sua config (per Chrome, `npx` scarica `chrome-devtools-mcp` da npm, con le statistiche verso Google spente).

## Sicurezza

Ciccio fa eseguire comandi sul tuo server a degli agenti: trattalo come un accesso SSH.

- Il login (passkey) serve sempre, anche dalla tailnet; app desktop e companion entrano con il loro token, preso una volta con un codice.
- Ogni agente lavora solo nel suo repo, con la sandbox anche in «Salta permessi»; i limiti sono descritti in [docs/tecnico.md](docs/tecnico.md#ogni-agente-solo-sul-suo-repo), compresi quelli che sono controlli sui comandi e non barriere vere.
- Un comando scritto apposta, dentro la sandbox, può leggere il token di gh. `setup.sh` collega GitHub con `gh auth login --web`, che vale per tutti i tuoi repo: per limitare il danno dai a gh un token fine-grained solo sui repo dei progetti (`gh auth login --with-token`, come l'utente di Ciccio). Con un token così, i repo dei progetti nuovi su GitHub li crei tu.
- I PC non si fidano del server: companion e app installano solo aggiornamenti firmati, e ogni segreto di 1Password o firma SSH chiesti da Ciccio si confermano anche in una finestra sul PC, con il riferimento o il server esatti.
- Limiti noti e come segnalare una vulnerabilità: [SECURITY.md](SECURITY.md).

## Sviluppo

Cosa serve, per parte:

| Parte | Serve |
| - | - |
| Server e interfaccia (`server/`, `web/`, `shared/`) | Node 24 o più recente e pnpm con corepack (`corepack enable`; la versione di pnpm è in `package.json`). `better-sqlite3` scarica un binario già compilato; se per la tua piattaforma non c'è lo compila, e servono gli strumenti di compilazione (`build-essential` e `python3` su Ubuntu). Per far girare gli agenti su Linux: `bubblewrap` e `socat`. |
| Companion (`companion/`) | [Bun](https://bun.com) 1.3.x per compilare i binari (la CI usa la 1.3.14); per le prove basta Node. |
| App del companion per Mac (`companion/mac/`) | macOS con Xcode o i suoi strumenti a riga di comando (`xcode-select --install`), per Swift. |
| App desktop (`desktop/`) | Rust (rustup) e i [prerequisiti di Tauri 2](https://v2.tauri.app/start/prerequisites/) del tuo sistema; Node per la CLI di Tauri. |
| Voce (`voice/`) | Python 3.12 con `venv` (`python3-venv` su Ubuntu). |

```bash
corepack enable
pnpm install
pnpm dev:server   # API su 127.0.0.1:8787 (CICCIO_PROJECTS_DIR per scegliere i repo)
pnpm dev:web      # interfaccia su Vite (http://localhost:5173) con proxy verso il server
pnpm typecheck
pnpm build        # interfaccia in dist/web, server in dist/server
```

Le prove del companion che non hanno bisogno di finestre girano ovunque: `pnpm exec tsx companion/test/file.ts` (e `comandi.ts`, `migrazioni.ts`, `transfer.ts`). La CI le fa girare su Linux a ogni push e PR su `main`, insieme a `pnpm typecheck` e `pnpm build`.

Com'è fatto dentro (server, companion, app desktop, protocolli): [docs/tecnico.md](docs/tecnico.md). Per contribuire: [CONTRIBUTING.md](CONTRIBUTING.md).

Interfaccia e documentazione sono in italiano; l'inglese arriverà.

**Fork.** Se distribuisci un tuo companion o una tua app desktop, cambia gli identificativi `it.costa.ciccio` e `it.costa.ciccio-companion` (`desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/src/`, `companion/mac/`, `companion/src/service.ts`, `companion/src/windows-ui.ts`): con quelli il sistema riconosce l'app, le sue notifiche e i suoi dati, e due app con lo stesso identificativo si confondono.

## Licenza

© 2026 Daniele Costa. Ciccio è software libero con licenza [AGPL-3.0-only](LICENSE): puoi usarlo, studiarlo, modificarlo e ridistribuirlo alle sue condizioni. Se offri Ciccio modificato come servizio ad altri, devi rendere disponibile anche il tuo codice (vedi `CICCIO_SOURCE_URL` in [Configurazione](#configurazione)).

Componenti di altri e le loro licenze: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Il Claude Agent SDK e Claude Code sono di Anthropic e non sono coperti da questa licenza.
