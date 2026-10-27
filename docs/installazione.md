# Installare e aggiornare Ciccio

Guida completa. La versione breve è nel [README](../README.md#installazione).

### Requisiti

- Un server **Ubuntu 24.04** vuoto, anche un VPS da pochi euro: 2 CPU e 4 GB di RAM bastano per qualche agente alla volta (x86_64 o arm64). Ti serve l'accesso come root (o un utente con sudo).
- Un account **[Tailscale](https://tailscale.com)** (gratuito per uso personale), obbligatorio: Ciccio si raggiunge dalla tua tailnet, non direttamente da internet. Tailscale va anche sul telefono e sul PC da cui apri Ciccio.
- Un **abbonamento Claude** a pagamento, uno qualsiasi: Pro, Max, Team o Enterprise. Ciccio e gli agenti lavorano con il tuo account claude.ai, con il login fatto sul server (lo guida `setup.sh`), e ne condividono i limiti di utilizzo. Il piano gratuito non basta: non include Claude Code.
- Un account **GitHub**, se gli agenti devono clonare, fare push e aprire PR.

Il resto (Node 24, git, gh, bubblewrap, socat, il profilo AppArmor della sandbox, Tailscale, ufw) lo installa `setup.sh`.

**Niente chiavi API.** Ciccio non funziona con una chiave API di Anthropic e non va usato così. Fa lavorare gli agenti in modalità agentica: chat lunghe che tengono il contesto da un giro all'altro, con i connettori e le skill del tuo account claude.ai. È costruito e provato solo con il login dell'abbonamento; con una chiave API il contesto si perderebbe e niente di tutto questo è stato provato. Per questo, se nell'ambiente del server c'è `ANTHROPIC_API_KEY` (o un altro accesso a consumo: `ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex, Foundry), Ciccio non lo passa alle sessioni.

**Non tutto è open source.** Ciccio funziona solo con il [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) (`@anthropic-ai/claude-agent-sdk`), che è software proprietario di Anthropic con le sue [condizioni commerciali](https://www.anthropic.com/legal/commercial-terms); con l'installazione arriva anche il programma di Claude Code, che l'SDK lancia. SDK, Claude Code e API di Anthropic non sono coperti dalla licenza di Ciccio. Dettagli in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

### Installazione

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

#### A mano

Per chi preferisce fare da sé, nell'ordine (dettagli in [docs/tecnico.md](tecnico.md#server)):

1. Come root: un utente senza sudo; `apt-get install git gh bubblewrap socat curl ca-certificates xz-utils build-essential python3 python3-venv ufw`; su Ubuntu 24.04 il profilo AppArmor per bubblewrap ([documentazione della sandbox](https://code.claude.com/docs/en/sandboxing)); Node 24 in `~utente/.local/node`; Tailscale collegato, con MagicDNS e HTTPS attivi nella console; `tailscale serve --bg --https=443 http://127.0.0.1:8787`; `loginctl enable-linger <utente>`.
2. Come l'utente: `git clone https://github.com/danielecosta7/ciccio ~/ciccio && cd ~/ciccio && CICCIO_OWNER_NAME=Giulia bash deploy/install.sh`. Scrive `~/.config/ciccio.env` commentato. Poi il login di claude.ai con il programma di Claude Code che arriva con l'SDK (`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*/…/claude auth login --claudeai`, il percorso esatto è in Configurazione), `systemctl --user restart ciccio`, `gh auth login` e `bash deploy/install.sh code` per il codice di attivazione.
3. Facoltativi, come root: copia gli script di root in `/usr/local/lib/ciccio` (`setup.sh --step copia-root`) e da lì `egress-firewall.sh`, `egress-helper.sh`, `apt-helper.sh`, `ssh-helper.sh`; la voce con `setup.sh --step voce`.

### Aggiornare

Come l'utente di Ciccio:

```bash
cd ~/ciccio && bash deploy/install.sh
```

Scarica il codice nuovo, compila e riavvia; prima aspetta che gli agenti al lavoro finiscano (al massimo 20 minuti, `FORCE=1` per non aspettare) e chi era a metà riprende da solo.

Gli script di root (firewall, helper con sudo) non si aggiornano da soli: se sono cambiati, `install.sh` lo dice alla fine e stampa il comando, `sudo bash /usr/local/lib/ciccio/setup.sh --step copia-root`, che mostra le differenze e chiede prima di installarle.

### Companion e app desktop

Due programmi facoltativi per i tuoi PC (Mac con Apple Silicon e Windows x64): il **companion**, che fa usare agli agenti i programmi del PC acceso, e l'**app desktop**, Ciccio in una finestra con le notifiche. Si scaricano da Ciccio stesso (Impostazioni › Companion e Impostazioni › App), che li prende dalle [release su GitHub](https://github.com/danielecosta7/ciccio/releases).

- **Sul server.** Al primo `install.sh` (cartella `~/.ciccio/downloads` vuota) Ciccio scarica da solo l'ultima release; per prenderne una nuova, come l'utente di Ciccio: `bash ~/ciccio/deploy/fetch-release.sh` (o `… fetch-release.sh 0.2.0` per una versione precisa; `CICCIO_FETCH_RELEASE=1 bash deploy/install.sh` lo fa a ogni aggiornamento). Lo script controlla le firme e mette i file in `~/.ciccio/downloads`; se GitHub non risponde non tocca niente.
- **Firmati.** Ogni release è firmata con una chiave Ed25519 che sta solo nelle GitHub Actions; la chiave pubblica è in [`shared/release-key.ts`](../shared/release-key.ts) ed è compilata dentro companion e app. `fetch-release.sh` controlla le firme prima di installare, e companion e app le ricontrollano prima di aggiornarsi: un server compromesso non può far installare ai tuoi PC un programma che non sia di una release firmata.
- **Aggiornamenti automatici.** Quando sul server c'è una versione nuova, companion e app collegati la scaricano da Ciccio e si aggiornano da soli (il companion quando non sta lavorando, l'app quando la finestra è chiusa).
- **Dal sorgente.** Se compili tu (`pnpm companion:build`, `pnpm desktop:build`, vedi [docs/tecnico.md](tecnico.md#companion-dei-pc)) e hai un fork con le tue release, genera la tua chiave con `node scripts/release-key.mjs genera` e mettila in `shared/release-key.ts` al posto di quella di questo repo: altrimenti i tuoi programmi accettano solo le release firmate qui, non le tue.
- **Non firmati da Apple né da Microsoft**: al primo avvio macOS chiede «Apri comunque» (Impostazioni di Sistema › Privacy e sicurezza) e Windows SmartScreen «Esegui comunque».

Per controllare a mano i file scaricati da GitHub: `node scripts/release-key.mjs verifica <cartella>` (con `companion.json`, `app.json`, i file e le loro `.sig`).
