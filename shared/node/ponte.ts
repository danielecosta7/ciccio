import type { Socket } from 'node:net';
import { SSH_BRIDGE_CHUNK, SSH_BRIDGE_CLOSE, SSH_BRIDGE_DATA, SSH_BRIDGE_ID, SSH_BRIDGE_IDLE_MS } from '../companion.js';

// Ponti SSH (shared/companion.ts): i byte di un socket (TCP sul PC, Unix sul server) passano sulla WebSocket del
// companion come ssh/bridge-data, a pezzi di al massimo 32 KiB in base64. La stessa tabella sta nelle due parti.
//
// Contropressione: chi manda smette di leggere dai suoi socket quando la WebSocket ha più di HIGH byte in coda e
// riprende sotto LOW. Chi riceve non può fermare l'altra parte: se un socket non smaltisce (più di MAX_QUEUED in coda
// verso di lui) il ponte si chiude, invece di riempire la memoria. Con ssh non succede: la strada lenta è internet.

const HIGH = 1024 * 1024;
const LOW = 256 * 1024;
const MAX_QUEUED = 16 * 1024 * 1024;
const CHECK_MS = 20;

/** Il collegamento con l'altra parte: mandare un messaggio, e quanto c'è in coda sulla WebSocket. */
export interface BridgeIO {
  send(msg: unknown): void;
  buffered(): number;
}

export interface BridgeStats { sent: number; received: number; ms: number }
export type BridgeClosed = (reason: string, stats: BridgeStats) => void;

interface Entry {
  /** null finché il ponte è solo prenotato (sul server: aspetta la risposta del PC a ssh/bridge-open). */
  sock: Socket | null;
  /** Byte arrivati prima del socket. */
  early: Buffer[];
  earlyBytes: number;
  last: number;
  t0: number;
  sent: number;
  received: number;
  onClose?: BridgeClosed;
  /** L'altra parte ha chiuso prima che il socket ci fosse. */
  remoteClosed?: string;
}

export class BridgeTable {
  private bridges = new Map<string, Entry>();
  private paused = false;
  private checker: ReturnType<typeof setInterval> | undefined;
  private idle: ReturnType<typeof setInterval>;

  constructor(private io: BridgeIO, private idleMs = SSH_BRIDGE_IDLE_MS) {
    this.idle = setInterval(() => {
      const now = Date.now();
      for (const [id, e] of this.bridges) if (e.sock && now - e.last > this.idleMs) this.close(id, `nessun traffico da ${Math.round(this.idleMs / 60_000)} minuti`);
    }, Math.min(60_000, Math.max(500, this.idleMs / 4)));
    this.idle.unref?.();
  }

  get size() { return this.bridges.size; }
  has(id: string) { return this.bridges.has(id); }

  /** Prenota il ponte `id` prima di chiederlo all'altra parte: i byte che arrivano intanto si tengono da parte. */
  reserve(id: string) {
    if (!SSH_BRIDGE_ID.test(id) || this.bridges.has(id)) throw new Error(`ponte ${id} non valido o già aperto`);
    this.bridges.set(id, { sock: null, early: [], earlyBytes: 0, last: Date.now(), t0: Date.now(), sent: 0, received: 0 });
  }

  /**
   * Collega il socket al ponte `id` (prenotato o nuovo): gli scrive i byte già arrivati e comincia a leggerlo.
   * `onClose` arriva una volta sola, da qualunque parte si chiuda.
   */
  attach(id: string, sock: Socket, onClose?: BridgeClosed) {
    let e = this.bridges.get(id);
    if (e?.sock) throw new Error(`ponte ${id} già aperto`);
    if (!e) { this.reserve(id); e = this.bridges.get(id)!; }
    const entry = e;
    entry.sock = sock;
    entry.onClose = onClose;
    entry.last = Date.now();
    if (sock.destroyed) { this.close(id, 'chiuso prima di cominciare'); return; }
    // Fermo prima di ascoltare 'data' se la WebSocket è piena: così il listener non lo fa partire da solo.
    if (this.paused) sock.pause();
    sock.on('data', (chunk: Buffer) => {
      if (this.bridges.get(id) !== entry) return;
      entry.last = Date.now();
      for (let o = 0; o < chunk.length; o += SSH_BRIDGE_CHUNK) {
        const part = chunk.subarray(o, o + SSH_BRIDGE_CHUNK);
        entry.sent += part.length;
        this.io.send({ jsonrpc: '2.0', method: SSH_BRIDGE_DATA, params: { id, data: part.toString('base64') } });
      }
      this.watchBuffer();
    });
    sock.on('end', () => this.close(id, 'chiuso'));
    sock.on('close', () => this.close(id, 'chiuso'));
    sock.on('error', (err) => this.close(id, err.message));
    for (const b of entry.early.splice(0)) sock.write(b);
    entry.earlyBytes = 0;
    if (entry.remoteClosed) { this.close(id, entry.remoteClosed, false); return; }
    // Un socket fermato prima (sul server: dopo la riga "host porta") riparte qui, se la WebSocket non è piena.
    if (!this.paused) sock.resume();
  }

  /** ssh/bridge-data dall'altra parte. */
  data(params: unknown) {
    const p = (params ?? {}) as { id?: unknown; data?: unknown };
    if (typeof p.id !== 'string' || typeof p.data !== 'string') return;
    const e = this.bridges.get(p.id);
    // Ponte già chiuso da questa parte: l'altra lo sa già (o lo saprà dal close in viaggio).
    if (!e || e.remoteClosed) return;
    const b = Buffer.from(p.data, 'base64');
    if (b.length > SSH_BRIDGE_CHUNK) { this.close(p.id, 'pezzo troppo grande'); return; }
    e.last = Date.now();
    e.received += b.length;
    if (!e.sock) {
      e.early.push(b);
      e.earlyBytes += b.length;
      if (e.earlyBytes > MAX_QUEUED) this.close(p.id, 'troppi dati in attesa');
      return;
    }
    e.sock.write(b);
    if (e.sock.writableLength > MAX_QUEUED) this.close(p.id, 'il socket non smaltisce i dati');
  }

  /**
   * ssh/bridge-close dall'altra parte: si chiude il socket senza rispondere. Un ponte ancora senza socket (il server
   * remoto ha mandato il suo saluto e chiuso prima che qui arrivasse la risposta all'apertura) resta prenotato con i
   * suoi byte: attach li scrive e poi chiude.
   */
  remoteClose(params: unknown) {
    const p = (params ?? {}) as { id?: unknown; reason?: unknown };
    if (typeof p.id !== 'string') return;
    const reason = typeof p.reason === 'string' ? p.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200) : 'chiuso dall\'altra parte';
    const e = this.bridges.get(p.id);
    if (e && !e.sock) { e.remoteClosed ??= reason; return; }
    this.close(p.id, reason, false);
  }

  /** Chiude il ponte: il socket (dopo aver scritto quello che ha in coda) e, con `tell`, l'altra parte. */
  close(id: string, reason: string, tell = true) {
    const e = this.bridges.get(id);
    if (!e) return;
    this.bridges.delete(id);
    if (tell) this.io.send({ jsonrpc: '2.0', method: SSH_BRIDGE_CLOSE, params: { id, reason } });
    const sock = e.sock;
    if (sock && !sock.destroyed) {
      sock.end();
      // Chi non chiude da sé dopo end() (o non ha più nessuno che legge) si chiude dopo poco.
      setTimeout(() => sock.destroy(), 2000).unref?.();
    }
    if (sock) e.onClose?.(reason, { sent: e.sent, received: e.received, ms: Date.now() - e.t0 });
  }

  /** Il collegamento è caduto: tutti i ponti si chiudono, senza dirlo all'altra parte. */
  closeAll(reason: string) {
    for (const id of [...this.bridges.keys()]) this.close(id, reason, false);
    clearInterval(this.checker);
    this.checker = undefined;
    this.paused = false;
  }

  /** Fine: chiude tutto e ferma il controllo dei ponti inattivi. */
  stop(reason: string) {
    this.closeAll(reason);
    clearInterval(this.idle);
  }

  /** WebSocket piena: tutti i socket fermi finché non torna sotto LOW. */
  private watchBuffer() {
    if (this.paused || this.io.buffered() <= HIGH) return;
    this.paused = true;
    for (const e of this.bridges.values()) e.sock?.pause();
    this.checker = setInterval(() => {
      if (this.io.buffered() > LOW && this.bridges.size) return;
      clearInterval(this.checker);
      this.checker = undefined;
      this.paused = false;
      for (const e of this.bridges.values()) e.sock?.resume();
    }, CHECK_MS);
  }
}
