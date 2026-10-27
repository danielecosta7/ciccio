# Configurazione

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

Il servizio voce (`deploy/ciccio-voice.service`) ha le sue: `CICCIO_VOICE_HOST` (`127.0.0.1`), `CICCIO_VOICE_PORT` (`8791`), `CICCIO_VOICE_MODELS` (`~/.ciccio/voice-models`), `CICCIO_VOICE_LANG` (`it`), `CICCIO_VOICE_THREADS` (`4`), `CICCIO_VOICE_WHISPER` (`whisper-base`). Quelle del companion e dell'app desktop sono in [docs/tecnico.md](tecnico.md#config).

Un dominio pubblico (per esempio dietro Caddy) è possibile: aggiungilo a `CICCIO_ORIGINS`. Il login resta obbligatorio da qualunque rete.

**Codice sorgente.** Ciccio è AGPL-3.0: chi lo usa dalla rete ha diritto al codice della versione che gira, e il link «Codice sorgente» glielo indica. Se offri ad altri una versione modificata, metti in `CICCIO_SOURCE_URL` l'indirizzo del codice di quella versione.
