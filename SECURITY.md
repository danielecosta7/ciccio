# Sicurezza

Ciccio fa eseguire comandi a degli agenti sul server dove gira: una falla può voler dire accesso al server, ai repo o ai PC collegati con il companion. Le segnalazioni sono benvenute e prese sul serio.

## Come segnalare

**Non aprire una issue pubblica.** Usa la segnalazione privata di GitHub: scheda **Security** del repo › **Report a vulnerability**. Scrivi:

- cosa si riesce a fare e da dove (da internet, dalla tailnet, da dentro un agente, da una pagina web, dal PC con il companion);
- i passi per riprodurlo, con la versione (commit) di Ciccio;
- se lo sai, dove sta il problema nel codice.

Rispondo appena posso, di solito entro qualche giorno. Quando la correzione è pronta la pubblico e, se vuoi, ti ringrazio per nome nelle note.

## Cosa segnalare

In particolare:

- entrare in Ciccio senza passkey o senza il token di un dispositivo;
- un agente che esce dal suo repo: legge o scrive altri progetti, i dati di Ciccio, le credenziali, o raggiunge la rete fuori dai domini consentiti;
- un agente, una pagina web o un link che fa approvare un permesso, usa i programmi di un PC o collega un companion senza che l'utente lo decida;
- segreti (chiavi, token, password) che finiscono nei log, nelle chat o nei file del repo;
- un modo per far installare a companion o app desktop un file non firmato, o di un'altra release (versione, programma o piattaforma diversi), passando dal server di Ciccio o dalla rete (vedi sotto);
- un server di Ciccio compromesso che legge un segreto di 1Password o ottiene una firma SSH dal PC senza la conferma nella finestra del PC, o con una finestra che mostra un riferimento o un server diversi da quelli veri.

## Limiti noti

Sono scelte o limiti di oggi, descritti in [docs/tecnico.md](docs/tecnico.md#ogni-agente-solo-sul-suo-repo). Non serve segnalarli; un modo nuovo per sfruttarli, o per aggirare i controlli che ci sono, sì.

- **Token di GitHub.** I comandi nella sandbox vedono la configurazione di gh, perché `gh` e `git push` ne hanno bisogno. Ciccio blocca i comandi che nominano altri repo o leggono il token in modo evidente, ma è un controllo sul testo del comando: un comando scritto apposta può ancora leggerlo. Dai a Ciccio un token fine-grained limitato ai repo dei progetti (`gh auth login --with-token`), non il login `--web` che vale per tutti i tuoi repo.
- **Impostazioni gestite di Claude Code.** Ciccio blocca hook, regole di permesso, server MCP e agenti che arrivano dai file del repo con le impostazioni gestite della sessione. Un file di impostazioni gestite sul server (in `/etc/claude-code/`) vale sopra quelle di Ciccio: lì non deve esserci, o deve essere tuo e scritto sapendo cosa fa.
- **Il firewall in uscita non protegge la riservatezza.** Limita dove gli agenti si collegano, non quello che portano fuori: un agente può far uscire dati da GitHub (push, issue, gist) o dai domini consentiti, e con le richieste DNS. Non dare a un agente dati che non vuoi possano uscire dal server.
- **Utente di Ciccio fuori dalla sandbox.** Chi ha una shell come l'utente di Ciccio (fuori dalla sandbox) vede tutti i progetti, i dati di Ciccio e le credenziali, e con l'helper dei programmi di sistema può installare pacchetti ufficiali di Ubuntu senza chiedere.

## Firma delle release

Companion e app desktop si aggiornano dal server di Ciccio, ma installano solo file di una release firmata: il manifest (`companion.json`, `app.json`) e ogni file sono firmati con Ed25519 da una chiave privata che sta solo nei segreti delle GitHub Actions (`CICCIO_RELEASE_KEY`, workflow `release.yml`); la chiave pubblica è in `shared/release-key.ts`, compilata dentro i programmi. Anche `deploy/fetch-release.sh` controlla le firme prima di mettere i file sul server. Se la chiave privata fosse esposta, la sostituisco come descritto in [docs/tecnico.md](docs/tecnico.md#firma-delle-release) e lo scrivo nelle note della release.

## Versioni

Si corregge solo l'ultima versione su `main`.
