// Protocollo tra Ciccio e l'app desktop «Ciccio» (desktop/, Mac e Windows).
//
// L'app è una finestra con Ciccio più le notifiche native. Non usa la passkey: si collega una volta sola
// e riceve un token suo (nel Portachiavi del Mac o nell'archivio credenziali di Windows), poi:
// - la finestra: l'app chiede un codice monouso (POST DESKTOP_SESSION_PATH con il token) e apre
//   DESKTOP_LOGIN_PATH?code=…&next=/…, che crea una sessione con un cookie che non finisce su disco;
// - gli avvisi: WebSocket DESKTOP_PATH con il token (Authorization: Bearer), messaggi JSON-RPC 2.0:
//     app → Ciccio   desktop/hello  { version, platform, companion? }
//                    desktop/decide { approvalId, allow }  (con id: risposta { ok, text })
//     Ciccio → app   desktop/welcome  { name }
//                    desktop/notify   DesktopNotify
//                    desktop/resolved { approvalId }       (deciso altrove: la notifica sparisce)
//                    desktop/update   UpdateParams         (come il companion, con DESKTOP_DOWNLOAD_PATH)
//                    desktop/ping
//
// Collegamento: dall'indirizzo Tailscale l'app crea da sola il suo token (POST /api/desktop/apps, che lì
// non chiede accesso). Da internet: POST DESKTOP_PAIR_PATH → codice da scrivere a mano in Impostazioni › App
// (nel browser, con la passkey; mai dall'indirizzo, contro i link di phishing); l'app chiede a
// DESKTOP_PAIR_PATH/poll finché il token è pronto.
//
// Notifiche doppie: se sullo stesso PC c'è il companion, l'app manda in desktop/hello lo sha256 del suo
// token (lo legge dalla config del companion; il server conserva solo quell'hash). Finché l'app è collegata,
// Ciccio non manda companion/notify a quel companion.

export const DESKTOP_PATH = '/desktop';
export const DESKTOP_PAIR_PATH = '/desktop/pair';
export const DESKTOP_SESSION_PATH = '/desktop/session';
export const DESKTOP_LOGIN_PATH = '/desktop/login';
export const DESKTOP_DOWNLOAD_PATH = '/desktop/download';

/** Una notifica per l'app. `approval`: i due pulsanti (primo = consenti, secondo = rifiuta). */
export interface DesktopNotify {
  id: string;
  title: string;
  body: string;
  /** Pagina di Ciccio da aprire al clic, es. /agente/<progetto>/<chat>. */
  path: string;
  tone?: 'done' | 'wait' | 'block';
  approval?: { id: string; allow: string; deny: string };
}

export interface DesktopDecide { approvalId: string; allow: boolean }
