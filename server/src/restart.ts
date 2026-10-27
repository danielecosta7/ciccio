import { store, type Thread } from './db.js';
import { bus } from './bus.js';
import { companions } from './companion.js';
import { abortAll, beginDrain, continueChat, parkApprovals, parkedTurns, queuedTurns, restartStreak, runningTurns, setRestartStreak, setSuggestion, type QueuedTurn, type TurnSnapshot } from './agents.js';
import { ciccioTurn, continueCiccio } from './ciccio.js';
import type { TurnOrigin } from './consumi.js';
import { CICCIO_THREAD, type MessageRole } from '../../shared/types.js';
import { OWNER } from './config.js';

// Riavvio senza perdere lavoro. Ogni giro di una chat è un processo dell'Agent SDK: un riavvio del server lo
// uccide, e prima il lavoro a metà si perdeva in silenzio finché l'utente non scriveva «continua».
// - Allo spegnimento (SIGTERM da systemd): nessun giro nuovo parte (i messaggi restano in coda), quelli al lavoro
//   hanno qualche secondo per finire, poi si annota chi era a metà e in che stato, coda compresa.
// - Una chat ferma sull'utente (permesso o domanda in attesa) non fa niente: non tiene fermo il riavvio. La sua
//   richiesta torna nella chat come card e il giro riprende quando l'utente risponde, con la sua risposta.
// - Una chat al lavoro riprende da sola all'avvio con un messaggio che spiega l'interruzione.
// - Niente cicli: dopo MAX_STREAK riprese di fila senza un giro finito bene, o dopo un crash (nessun registro
//   dello spegnimento), la chat resta ferma con una nota e «Continua» tra i suggerimenti.

const KEY = 'shutdown_record';
const secs = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return (Number.isFinite(v) && v >= 0 ? v : fallback) * 1000;
};
/** Quanto aspettano i giri al lavoro prima dello spegnimento (systemd ne concede 60: TimeoutStopSec). */
const GRACE_MS = secs('CICCIO_SHUTDOWN_GRACE_S', 20);
/** Quanto aspetta la ripresa i PC che erano collegati (il companion si ricollega in pochi secondi). */
const PC_WAIT_MS = secs('CICCIO_RESUME_PC_WAIT_S', 30);
const MAX_STREAK = 2;

interface ShutdownRecord {
  at: number;
  reason: string;
  chats: TurnSnapshot[];
  queue: QueuedTurn[];
  ciccio: TurnSnapshot | null;
  ciccioQueue: string[];
  /** PC con il companion accesi allo spegnimento: la ripresa li aspetta, se no gli agenti non avrebbero i loro strumenti. */
  pcs: string[];
}

/** Riprese dell'ultimo avvio non ancora partite (aspettano i PC): un altro riavvio adesso non deve perderle. */
let notYet: ShutdownRecord | null = null;

function snapshot(reason: string): ShutdownRecord {
  const c = ciccioTurn();
  // Con le chat al lavoro anche quelle con card riproposte da un riavvio prima e ancora senza risposta.
  const parkedNow = parkedTurns();
  const r: ShutdownRecord = {
    at: Date.now(), reason, chats: [...runningTurns(), ...parkedNow.filter((t) => t.chatId !== CICCIO_THREAD)], queue: queuedTurns(),
    ciccio: c.turn ?? parkedNow.find((t) => t.chatId === CICCIO_THREAD) ?? null, ciccioQueue: c.queue,
    pcs: companions().filter((p) => p.online).map((p) => p.name),
  };
  if (notYet) {
    const busy = new Set(r.chats.map((t) => t.chatId));
    r.chats.push(...notYet.chats.filter((t) => !busy.has(t.chatId)));
    r.ciccio ??= notYet.ciccio;
    r.queue.unshift(...notYet.queue);
    r.ciccioQueue.unshift(...notYet.ciccioQueue);
    r.pcs = [...new Set([...r.pcs, ...notYet.pcs])];
  }
  return r;
}

const describe = (t: TurnSnapshot) => {
  if (t.chatId === CICCIO_THREAD) return 'Ciccio';
  const chat = store.chat(t.chatId);
  return `${t.agentId} / ${chat?.title ?? t.chatId}`;
};

/** Chi lavora e chi aspetta l'utente adesso: per il deploy (deploy/install.sh aspetta solo i primi). */
export function activityNow() {
  const c = ciccioTurn();
  const turns = [...runningTurns(), ...(c.turn ? [c.turn] : [])];
  return {
    working: turns.filter((t) => t.activity === 'work').map(describe),
    waiting: turns.filter((t) => t.activity === 'wait').map(describe),
    queued: queuedTurns().length + c.queue.length,
  };
}

let stopping = false;

/** Spegnimento gentile: chiamato al SIGTERM; `close` chiude il server HTTP. Esce da solo. */
export async function shutdown(reason: string, close: () => Promise<void>) {
  if (stopping) return;
  stopping = true;
  beginDrain();
  // Il registro si riscrive a ogni passo: se systemd perde la pazienza, all'avvio c'è comunque l'ultimo.
  const save = () => { const r = snapshot(reason); store.setKv(KEY, r); return r; };
  let r = save();
  // Solo i giri vivi: quelli ereditati da un riavvio precedente e non ancora ripartiti non finiscono da soli.
  const working = () => activityNow().working;
  const deadline = Date.now() + GRACE_MS;
  if (working().length) console.log(`Spegnimento: aspetto al massimo ${GRACE_MS / 1000} s i giri al lavoro (${working().join(', ')})`);
  while (working().length && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 500));
    r = save();
  }
  const all = [...r.chats, ...(r.ciccio ? [r.ciccio] : [])];
  console.log(all.length || r.queue.length || r.ciccioQueue.length
    ? `Spegnimento: riprendo all'avvio ${all.map((t) => `${describe(t)} (${t.activity === 'work' ? 'al lavoro' : `aspetta ${OWNER}`})`).join(', ') || 'nessun giro'}; in coda ${r.queue.length + r.ciccioQueue.length}`
    : 'Spegnimento: nessun giro in corso');
  await Promise.race([close().catch(() => undefined), new Promise((res) => setTimeout(res, 3000))]);
  // I processi dei giri si chiudono con l'abort; quello che resta lo ferma systemd (KillMode=mixed).
  abortAll();
  setTimeout(() => process.exit(0), 1000).unref();
}

function note(thread: Thread, text: string) {
  bus.emit({ type: 'message', message: store.addMessage(thread, 'tool', text) });
}

const threadOf = (t: { chatId: string; agentId: string }): Thread => ({ chatId: t.chatId, agentId: t.agentId });

/** Messaggio con cui riprende un giro interrotto al lavoro. */
function continuation(t: TurnSnapshot): string {
  const lines = [
    '[Ciccio, la sala controllo, è stato riavviato (aggiornamento del server) mentre lavoravi: il tuo giro di prima si è interrotto a metà, e i comandi e i sub-agent ancora in corso sono stati fermati.',
    "Riprendi da dove eri arrivato, senza ricominciare da capo: guarda a che punto sei (file, git status, l'ultimo risultato) e rifai l'ultimo passo se non risulta finito.",
  ];
  if (t.tools.length) lines.push(`Strumenti rimasti a metà: ${t.tools.join(' · ')}.`);
  if (t.approvals.length) lines.push(`Aspettavi anche ${OWNER} per: ${t.approvals.map((a) => a.summary.split('\n')[0]).join(' · ')}. Quelle richieste sono scadute con il riavvio: se ti servono ancora, rifai il passo e gli ricompaiono.`);
  if (t.routine) lines.push(`Il giro l'aveva fatto partire la routine «${t.routine.name}»: chiudi il lavoro da solo come prima.`);
  return `${lines.join('\n')}]`;
}

/** Messaggio con cui riprende un giro che aspettava l'utente, dopo le sue risposte alle card riproposte. */
function afterAnswers(answers: string[]): string {
  return `[Ciccio è stato riavviato (aggiornamento del server) mentre aspettavi ${OWNER}: il tuo giro di prima si è interrotto lì e ora riprende. Intanto ${OWNER} ha risposto:\n${answers.map((a) => `- ${a}`).join('\n')}\nRiprendi da dove eri.]`;
}

/** Avvia il giro di ripresa (agente o Ciccio). */
function start(t: { chatId: string; from?: MessageRole; routine?: TurnSnapshot['routine']; origin?: TurnOrigin }, text: string, origin = t.origin) {
  if (t.chatId === CICCIO_THREAD) continueCiccio(text);
  else continueChat(t.chatId, text, t.from ?? 'user', t.routine, origin);
}

/** Troppe interruzioni di fila: niente ripresa automatica, l'utente decide. */
function holdBack(thread: Thread, why: string) {
  note(thread, why);
  setSuggestion(thread.chatId, 'Continua da dove eri: il giro di prima si è interrotto per un riavvio di Ciccio.');
}

function resumeTurn(t: TurnSnapshot) {
  const thread = threadOf(t);
  // Fermo sull'utente: si ripropongono le richieste, il giro riparte con le sue risposte (nessun costo intanto).
  if (t.activity === 'wait' && t.approvals.length) {
    parkApprovals(t, (answers) => { note(thread, 'riprendo il giro con le tue risposte'); start(t, afterAnswers(answers), 'ripresa'); });
    note(thread, 'Ciccio è stato riavviato: ti ripropongo la richiesta, riprendo appena rispondi');
    return;
  }
  const streak = restartStreak(t.chatId) + 1;
  if (streak > MAX_STREAK) {
    setRestartStreak(t.chatId, 0);
    holdBack(thread, `Ciccio è stato riavviato di nuovo a metà giro (${streak} volte di fila): non riprendo da solo, scrivi «continua» quando vuoi`);
    return;
  }
  setRestartStreak(t.chatId, streak);
  note(thread, 'Ciccio è stato riavviato: riprendo da dove ero');
  start(t, continuation(t), 'ripresa');
}

/** All'avvio, prima di aprire il server: riprende i giri interrotti dallo spegnimento e avvisa di quelli caduti. */
export function resumeAfterRestart() {
  const r = store.getKv<ShutdownRecord>(KEY) ?? null;
  store.setKv(KEY, null);
  const clean = new Set([...(r?.chats ?? []).map((t) => t.chatId), ...(r?.ciccio ? [CICCIO_THREAD] : [])]);
  // Giri aperti senza registro: il server è caduto (errore, memoria) e il giro potrebbe esserne la causa.
  const crash = 'Ciccio si è fermato di colpo (errore o memoria piena) a metà di questo giro: non riprendo da solo, per non ripetere un giro che forse l\'ha fatto cadere. Scrivi «continua» quando vuoi';
  for (const chat of store.chatsInTurn()) {
    store.updateChat(chat.id, { turn_started: null });
    if (!clean.has(chat.id)) holdBack({ chatId: chat.id, agentId: chat.agent_id }, crash);
  }
  if (store.getKv<number>('ciccio_turn_started')) {
    store.setKv('ciccio_turn_started', null);
    if (!clean.has(CICCIO_THREAD)) holdBack({ chatId: CICCIO_THREAD, agentId: CICCIO_THREAD }, crash);
  }
  if (!r) return;
  const turns = [...r.chats, ...(r.ciccio ? [r.ciccio] : [])].filter((t) => t.chatId === CICCIO_THREAD || store.chat(t.chatId));
  if (!turns.length && !r.queue.length && !r.ciccioQueue.length) return;
  console.log(`Ripresa dopo il riavvio: ${turns.map((t) => `${describe(t)} (${t.activity === 'work' ? 'al lavoro' : `aspetta ${OWNER}`})`).join(', ') || 'nessun giro'}; in coda ${r.queue.length + r.ciccioQueue.length}`);
  // Le card riproposte subito; i giri dopo che i PC collegati prima sono tornati (al massimo PC_WAIT_MS).
  const parks = (t: TurnSnapshot) => t.activity === 'wait' && t.approvals.length > 0;
  for (const t of turns) if (parks(t)) resumeTurn(t);
  const later = turns.filter((t) => !parks(t));
  notYet = { ...r, chats: later.filter((t) => t.chatId !== CICCIO_THREAD), ciccio: later.find((t) => t.chatId === CICCIO_THREAD) ?? null };
  const deadline = Date.now() + PC_WAIT_MS;
  const go = () => {
    if (stopping) return;
    const online = new Set(companions().filter((p) => p.online).map((p) => p.name));
    if (r.pcs.some((n) => !online.has(n)) && Date.now() < deadline) { setTimeout(go, 1000).unref(); return; }
    notYet = null;
    for (const t of later) resumeTurn(t);
    // Poi i messaggi rimasti in coda, nell'ordine di prima (dietro le riprese delle stesse chat).
    for (const q of r.queue) start(q, q.text);
    for (const text of r.ciccioQueue) continueCiccio(text);
  };
  go();
}
