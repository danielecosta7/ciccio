# Sicurezza e connessioni esterne

Come segnalare una vulnerabilità e i limiti noti: [SECURITY.md](../SECURITY.md).

### Sicurezza

Ciccio fa eseguire comandi sul tuo server a degli agenti: trattalo come un accesso SSH.

- Il login (passkey) serve sempre, anche dalla tailnet; app desktop e companion entrano con il loro token, preso una volta con un codice.
- Ogni agente lavora solo nel suo repo, con la sandbox anche in «Salta permessi»; i limiti sono descritti in [docs/tecnico.md](tecnico.md#ogni-agente-solo-sul-suo-repo), compresi quelli che sono controlli sui comandi e non barriere vere.
- Un comando scritto apposta, dentro la sandbox, può leggere il token di gh. `setup.sh` collega GitHub con `gh auth login --web`, che vale per tutti i tuoi repo: per limitare il danno dai a gh un token fine-grained solo sui repo dei progetti (`gh auth login --with-token`, come l'utente di Ciccio). Con un token così, i repo dei progetti nuovi su GitHub li crei tu.
- I PC non si fidano del server: companion e app installano solo aggiornamenti firmati, e ogni segreto di 1Password o firma SSH chiesti da Ciccio si confermano anche in una finestra sul PC, con il riferimento o il server esatti.
- Limiti noti e come segnalare una vulnerabilità: [SECURITY.md](../SECURITY.md).

### Connessioni esterne

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
