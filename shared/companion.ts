// Protocollo tra Ciccio e il companion dei PC (WebSocket /companion, messaggi JSON-RPC 2.0).
//
// Il companion apre la connessione in uscita con il token del dispositivo (Authorization: Bearer),
// poi:  companion → Ciccio  companion/hello { protocol, version, platform, servers }
//                           companion/servers { servers }            (quando cambiano)
//                           companion/onepassword { sshAgent, cli }  (quando 1Password cambia)
//                           companion/usage { buckets, at }          (consumi di Claude Code del PC, ogni ora: shared/consumi.ts)
//                           companion/ssh-bridges { targets }        (quando cambiano i ponti SSH consentiti, vedi sotto)
//       Ciccio → companion  tools/call { id, params: { server, name, arguments } }
//                           notifications/cancelled { requestId }    (la sessione ha interrotto)
//       nei due versi        ssh/bridge-data, ssh/bridge-close       (ponti SSH aperti, vedi sotto)
// Le risposte sono { id, result } oppure { id, error: { code, message } }.

export const COMPANION_PROTOCOL = 1;
export const COMPANION_PATH = '/companion';

/** Strumento MCP così come lo descrive il server locale (tools/list). */
export interface LocalTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** Solo per gli strumenti integrati del companion: TRANSFER_META dice che lo strumento scambia un file con Ciccio. */
  _meta?: Record<string, unknown>;
}

export interface LocalServerState {
  /** Nome scelto nella config del companion (es. "affinity"), solo lettere minuscole, cifre e trattini. */
  name: string;
  status: 'online' | 'offline';
  error?: string;
  instructions?: string;
  tools: LocalTool[];
}

export interface HelloParams {
  protocol: number; version: string; platform: string; servers: LocalServerState[];
  /** true = l'app dell'icona (Mac o Windows) è accesa e l'opzione «Notifiche di Ciccio» è attiva. */
  notifications?: boolean;
  /** Cosa offre 1Password su questo PC: l'agent SSH e la CLI op (lettura dei segreti con Touch ID). */
  onePassword?: OnePasswordFeatures;
  /** Ponti SSH consentiti su questo PC, come "host:porta" (ssh.ponti nella config, vedi sotto). */
  sshBridges?: string[];
}

export interface OnePasswordFeatures { sshAgent: boolean; cli: boolean }

// ── Ponti SSH attraverso il PC ──────────────────────────────────────────
// Per i server SSH che il VPS non raggiunge (es. 192.168.1.50 nella rete dell'ufficio): il PC con il companion
// apre la connessione TCP e Ciccio ci fa passare i byte di ssh. Il PC decide quali destinazioni: solo le voci
// "host:porta" esatte di ssh.ponti nella sua config, che dice a Ciccio in hello (sshBridges) e in
// companion/ssh-bridges { targets } quando cambiano.
//
// Ciccio → companion, richieste con id e risposta:
//   ssh/bridge-open    { id, host, port }          → { ok: true }    apre il ponte `id` (scelto da Ciccio) verso
//                                                                     host:porta, solo se è in ssh.ponti; errore se no
//   ssh/bridge-propose { host, port, motivo? }     → { esito }       finestra sul PC: «Consenti» lo aggiunge a ssh.ponti;
//                                                                     esito 'consentito' | 'già' | 'rifiutato' | 'nessuna_risposta'
//   ssh/bridge-remove  { host, port }              → { tolto }       lo toglie da ssh.ponti (e chiude i suoi ponti aperti)
// Poi, nei due versi, notifiche senza id:
//   ssh/bridge-data    { id, data }                 byte del ponte in base64, al massimo SSH_BRIDGE_CHUNK per messaggio
//   ssh/bridge-close   { id, reason? }              chiuso da quella parte: l'altra chiude il suo socket
// Ogni parte smette di leggere dal suo socket quando la WebSocket ha troppo in coda (bufferedAmount), e riprende
// quando si svuota. Quando il collegamento cade si chiudono tutti i ponti; al massimo SSH_BRIDGE_MAX per PC; un
// ponte senza traffico per SSH_BRIDGE_IDLE_MS si chiude da solo.
export const SSH_BRIDGE_OPEN = 'ssh/bridge-open';
export const SSH_BRIDGE_PROPOSE = 'ssh/bridge-propose';
export const SSH_BRIDGE_REMOVE = 'ssh/bridge-remove';
export const SSH_BRIDGE_DATA = 'ssh/bridge-data';
export const SSH_BRIDGE_CLOSE = 'ssh/bridge-close';
export const SSH_BRIDGES_CHANGED = 'companion/ssh-bridges';
export const SSH_BRIDGE_CHUNK = 32 * 1024;
export const SSH_BRIDGE_MAX = 8;
export const SSH_BRIDGE_IDLE_MS = 2 * 60 * 60_000;
export const SSH_BRIDGE_ID = /^[A-Za-z0-9_-]{1,40}$/;
export type BridgeProposal = 'consentito' | 'già' | 'rifiutato' | 'nessuna_risposta';

/**
 * Destinazione di un ponte: nome host o IPv4, con la porta (22 se manca). Minuscole; niente utente, spazi o IPv6.
 * null se non è valida.
 */
export function parseBridgeTarget(raw: string, port?: number): { host: string; port: number; key: string } | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*)(?::(\d{1,5}))?$/.exec(String(raw ?? '').trim());
  if (!m || m[1].length > 253 || /-(\.|$)/.test(m[1])) return null;
  if (m[2] != null && port != null) return null;
  const p = port ?? (m[2] != null ? Number(m[2]) : 22);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  const host = m[1].toLowerCase();
  // Quattro numeri: deve essere un IPv4 vero (niente 999.1.1.1 o 010.0.0.1, che i resolver leggono a modo loro).
  if (/^[\d.]+$/.test(host) && !/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) return null;
  return { host, port: p, key: `${host}:${p}` };
}

// ── 1Password ───────────────────────────────────────────────────────────
// Ciccio → companion, richieste con id e risposta:
//   ssh/agent   { message: base64 }  → { message: base64 }   un messaggio del protocollo ssh-agent, girato
//                                                              all'agent SSH di 1Password (solo elenco chiavi e firma)
//   secret/read { ref: "op://…", motivo? } → { value }        op read sul PC: 1Password chiede Touch ID
// Le chiavi private non lasciano mai 1Password; i segreti letti non vengono salvati da nessuna parte.
//
// Il PC non si fida dell'approvazione data in Ciccio (un server compromesso potrebbe inventarla):
// - secret/read: prima di leggere compare una finestra sul PC con il riferimento op:// esatto (e il motivo
//   scritto dall'agente, solo come informazione); «Consenti sempre» lo aggiunge a onePassword.segreti
//   nella config del PC, e da lì in poi passa senza finestra;
// - ssh/agent: si firmano solo richieste di accesso SSH (SSH_MSG_USERAUTH_REQUEST, mai dati qualsiasi),
//   con una finestra che dice utente e server. Il server lo sa dal messaggio session-bind@openssh.com che ssh
//   manda all'agent prima di firmare: Ciccio lo passa in `bind` (base64) e il PC ne controlla la firma della
//   chiave del server e cerca il nome in ~/.ssh/known_hosts. «Consenti sempre» va in onePassword.ssh.
export const SSH_AGENT_METHOD = 'ssh/agent';
export const SECRET_READ_METHOD = 'secret/read';
/** Riferimento a un campo di 1Password: op://vault/elemento/campo (anche con sezione). */
export const OP_REF = /^op:\/\/[^\s/][^\s]*\/[^\s]+\/[^\s]+$/;
export interface CallParams {
  server: string; name: string; arguments?: Record<string, unknown>;
  /** Solo per scarica_da_ciccio e carica_su_ciccio: il file che Ciccio ha preparato per questa chiamata. */
  transfer?: TransferParams;
}

// ── File tra Ciccio e il PC ─────────────────────────────────────────────
// Gli strumenti scarica_da_ciccio e carica_su_ciccio del server «file» si dichiarano con
// _meta[TRANSFER_META] = 'download' | 'upload'. Quando un agente li chiama, Ciccio controlla il percorso
// nel repo del progetto di quell'agente e prepara un token monouso (pochi minuti, legato al PC e a quel
// file) che passa al companion in CallParams.transfer. Il companion controlla la cartella del PC e poi:
//   download  GET  COMPANION_TRANSFER_PATH/<token>  (con il token del dispositivo) → il file
//   upload    PUT  COMPANION_TRANSFER_PATH/<token>  application/octet-stream     → { percorso, dimensione, sha256 }
// Il companion parla solo con il server della sua config: da Ciccio prende il token, mai un indirizzo.
export const TRANSFER_META = 'ciccio/transfer';
export const COMPANION_TRANSFER_PATH = '/companion/transfer';
/** Dimensione massima di un file scambiato, nei due versi. */
export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;
export type TransferKind = 'download' | 'upload';
/** Strumento del companion e argomento con il percorso nel repo, per verso. */
export const TRANSFER_TOOLS: Record<TransferKind, { tool: string; repoArg: string }> = {
  download: { tool: 'scarica_da_ciccio', repoArg: 'file_sul_server' },
  upload: { tool: 'carica_su_ciccio', repoArg: 'destinazione_sul_server' },
};
export interface TransferParams {
  verso: TransferKind;
  token: string;
  /** Percorso nel repo, relativo (da mostrare). */
  percorso: string;
  /** Download: dimensione e sha256 del file sul server. */
  dimensione?: number;
  sha256?: string;
  /** Upload: dimensione massima accettata. */
  massimo?: number;
}
export const TRANSFER_TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

export type RpcId = number | string;
export type RpcMessage =
  | { jsonrpc: '2.0'; id: RpcId; method: string; params?: unknown }
  | { jsonrpc: '2.0'; method: string; params?: unknown }
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string } };

/** Nome di un server locale valido nei nomi degli strumenti: minuscole, cifre e trattini. */
export function serverSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

// ── Aggiornamento automatico ────────────────────────────────────────────
// Sul server, <dataDir>/downloads/companion.json dice qual è l'ultima versione e quale file
// scaricare per ogni piattaforma, con sha256 e firma Ed25519 di ogni file; companion.json.sig è la firma
// del manifest. Li scrive la release firmata (.github/workflows/release.yml, poi deploy/fetch-release.sh)
// o companion/publish.sh con la chiave; formato in shared/node/release.ts:
//   { "product": "companion", "version": "0.3.0",
//     "files": { "darwin-arm64": { "file": "CiccioCompanion-mac.zip", "sha256": "…", "size": 123, "sig": "…" }, … },
//     "installers": { … } }
// Dopo companion/hello (e poi ogni 10 minuti) Ciccio manda companion/update a chi ha una versione
// più vecchia, con il testo esatto del manifest e la sua firma. Il companion controlla la firma con la chiave
// pubblica che ha dentro (shared/release-key.ts), scarica il file con il suo token da COMPANION_DOWNLOAD_PATH/<file>,
// controlla dimensione, sha256 e firma del file e solo allora lo installa (Mac: l'app della barra dei menu;
// Windows: l'.exe). Senza firma valida, o con il segnaposto al posto della chiave, non installa niente.

export const COMPANION_DOWNLOAD_PATH = '/companion/download';

export interface UpdateManifest {
  product?: string;
  version: string;
  files: Record<string, { file: string; sha256: string; size: number; sig?: string }>;
  installers?: Record<string, { file: string; sha256: string; size: number; sig?: string }>;
}
export interface UpdateParams {
  version: string; file: string; sha256: string; size: number; url: string;
  /** Testo esatto del manifest (companion.json o app.json) e la sua firma in base64 (.json.sig). */
  manifest?: string;
  signature?: string;
}

/** true se la versione a è più nuova di b (numeri separati da punti: 0.10.0 > 0.9.3). */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

// ── Notifiche ───────────────────────────────────────────────────────────
// Gli avvisi di Ciccio (giro finito, permesso richiesto, agente bloccato) arrivano ai PC che hanno
// le notifiche attive come companion/notify. Il companion scrive ogni notifica in un file
// ~/.ciccio-companion/notify/<id>.json (NotifyParams); l'app dell'icona lo legge, mostra la
// notifica del sistema con l'icona di Ciccio, apre url al clic e cancella il file.

export interface NotifyParams {
  id: string;
  title: string;
  body: string;
  /** Pagina di Ciccio da aprire al clic (la chat dell'agente, o la dashboard). */
  url: string;
  tone?: 'done' | 'wait' | 'block';
}
