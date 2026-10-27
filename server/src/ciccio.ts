import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { config, claudeEnv, OWNER } from './config.js';
import { store, type Thread } from './db.js';
import { agentEvents, bus } from './bus.js';
import { isViewing } from './presence.js';
import { ONLY_OWNER, contextTracker, dropTail, keepTail, setSuggestion, setHidden, addRule, allowRules, archiveChat, clearError, compactChat, newSession, createChat, decideApproval, removeRule, renameAgent, renameChat, sendToChat, setConnectors, setModel, setPcTools, setPermission, stopChat, allAgents, askApproval, askQuestion, emitLive, handleMessage, sendToAgent, stopAgent, trackSession, untrackSession, isDraining, newRunning, setRestartStreak, staleNote, clearPreapproved, turnSnapshot, type Running, type TurnSnapshot } from './agents.js';
import { decide } from './policy.js';
import { confine } from './confine.js';
import { plainAction, plainText } from './plainAction.js';
import { settings, updateSettings } from './settings.js';
import { syncProjects } from './projects.js';
import { createProject } from './newProject.js';
import { currentUsage, onSubscription, recordUsage } from './usage.js';
import { companions } from './companion.js';
import { readStatusMd } from './projects.js';
import { noteTurn, type TurnOrigin } from './consumi.js';
import { pcMcpServers, pcPrompt, pcToolHints, releasePcServers } from './companion.js';
import { ciccioKey, hoistCommand, saveCommands } from './commands.js';
import { PROPOSALS, ROUTINE_TOOL, projectToolViews, removeProjectTool } from './projectTools.js';
import { describeCron } from '../../shared/cron.js';
import { dayIn } from '../../shared/tz.js';
import { createRoutine, findRoutine, fireRoutine, removeRoutine, routineViews, updateRoutine } from './routines.js';
import { ASK_TOOL, CICCIO_THREAD, EFFORTS, MODELS, type ContextInfo, type Effort, type NoticeMeta, type Recap, type RecapTone, type RoutineView } from '../../shared/types.js';

const CICCIO: Thread = { chatId: CICCIO_THREAD, agentId: CICCIO_THREAD };

const CICCIO_SYSTEM = `Sei Ciccio, il responsabile degli agenti AI di ${OWNER}. Ogni agente lavora su un progetto (un repo git).
Il tuo lavoro: sapere come stanno tutti, riassumere a ${OWNER} cosa conta, passare i suoi messaggi all'agente giusto.
Non scrivi codice e non approvi permessi. Parli in italiano, frasi brevi, tono diretto e amichevole.`;

/** Una chiamata secca a Claude senza strumenti. */
async function ask(prompt: string): Promise<string> {
  let out = '';
  const q = query({
    prompt,
    options: {
      cwd: config.dataDir,
      model: settings().ciccioModel,
      effort: settings().ciccioEffort,
      maxTurns: 1,
      // Nessuno strumento: senza, ogni chiamata si porterebbe dietro le definizioni di tutti quelli di Claude Code.
      tools: [],
      permissionMode: 'dontAsk',
      settingSources: [],
      systemPrompt: CICCIO_SYSTEM,
      env: claudeEnv,
    },
  });
  for await (const msg of q) {
    recordUsage(msg);
    if (msg.type === 'result') {
      // Anche un «success» può essere un errore (chiave non valida, login scaduto): il testo è il messaggio d'errore.
      if (msg.subtype === 'success' && !msg.is_error) out = msg.result;
      else throw new Error(`Ciccio non ha risposto: ${(msg.subtype === 'success' ? msg.result : msg.subtype).split('\n')[0]}`);
    }
  }
  return out.trim();
}

const today = () => dayIn();

function zoneHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
}

export function latestRecap(): Recap | null {
  return store.latestRecap() ?? null;
}

/** Dopo un riepilogo non riuscito si riprova tra un'ora, non a ogni minuto (ogni prova avvia Claude). */
const RECAP_RETRY_MS = 60 * 60_000;
type RecapFailure = { day: string; at: number; error: string };

/** Perché il riepilogo di oggi non c'è, se l'ultima prova di oggi è fallita. */
export function recapError(): string | null {
  const f = store.getKv<RecapFailure>('recap_failure');
  return f && f.day === today() && !store.recap(today()) ? f.error : null;
}

let generating = false;

/** Ogni giorno dalle config.recapHour (nel fuso di Ciccio), se manca il riepilogo di oggi, Ciccio lo prepara. */
export function startDailyRecap() {
  const tick = () => {
    if (generating || zoneHour() < settings().recapHour || store.recap(today())) return;
    // Senza progetti non c'è niente da riassumere.
    if (!store.agents().length) return;
    const failed = store.getKv<RecapFailure>('recap_failure');
    if (failed && failed.day === today() && Date.now() - failed.at < RECAP_RETRY_MS) return;
    generating = true;
    recap(true)
      .then((r) => {
        // Il riepilogo del mattino apre anche la chat con Ciccio.
        const text = `Buongiorno! ${r.headline}\n\n${r.lines.map((l) => `- ${l.text}`).join('\n')}`;
        bus.emit({ type: 'message', message: store.addMessage(CICCIO, 'agent', text) });
      })
      .catch((err) => console.error('Riepilogo del giorno non riuscito:', err))
      .finally(() => { generating = false; });
  };
  tick();
  setInterval(tick, 60_000).unref();
}

function ago(ms: number | null): string {
  if (!ms) return 'mai';
  const h = Math.round((Date.now() - ms) / 3_600_000);
  return h < 24 ? `${h} h fa` : `${Math.round(h / 24)} giorni fa`;
}

function situation(): string {
  const rows = store.agents();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines: string[] = [];
  const quiet: string[] = [];
  for (const a of allAgents()) {
    if (a.hidden) continue; // nascosto dall'utente: non conta per Ciccio
    if (a.status === 'idle' && !a.hasStatusMd) { quiet.push(a.id); continue; }
    const row = byId.get(a.id);
    const s = row ? readStatusMd(row.path) : null;
    const excerpt = s ? s.raw.replace(/\s+/g, ' ').slice(0, 500) : '';
    lines.push(`- ${a.id}${a.name !== a.id ? ` (${OWNER} lo chiama "${a.name}")` : ''} | stato: ${a.status} | ${a.line} | ultima attività: ${ago(a.lastActivity)}${excerpt ? ` | STATUS.md: ${excerpt}` : ''}`);
  }
  if (quiet.length) lines.push(`- In ordine, senza lavoro aperto: ${quiet.join(', ')}`);
  return lines.join('\n');
}

const TONES: RecapTone[] = ['wait', 'block', 'done', 'stale', 'work', 'info'];

export async function recap(force = false): Promise<Recap> {
  const day = today();
  const cached = store.recap(day);
  if (cached && !force) return cached;
  bus.emit({ type: 'ciccio', phase: 'thinking' });
  try {
    const text = await ask(`Situazione degli agenti adesso:
${situation()}

Scrivi il riepilogo per ${OWNER}, che apre Ciccio per la prima volta oggi. Formato esatto, niente altro:
TITOLO: <una frase: quanti agenti lo aspettano, quanti bloccati, la cosa più importante>
- [wait|block|done|stale|work|info] <una riga per voce, al massimo 6 righe, prima ciò che richiede ${OWNER}>
Usa wait per chi aspetta ${OWNER}, block per chi è bloccato da un errore, done per lavoro finito o PR da rivedere, stale per progetti fermi da tempo, work per chi sta lavorando.`);
    const headline = text.match(/^TITOLO:\s*(.+)$/m)?.[1]?.trim() ?? 'Ecco come stanno gli agenti.';
    const lines = [...text.matchAll(/^-\s*\[(\w+)\]\s*(.+)$/gm)].map((m) => ({
      tone: (TONES.includes(m[1] as RecapTone) ? m[1] : 'info') as RecapTone,
      text: m[2].trim(),
    }));
    const r: Recap = { day, headline, lines, ts: Date.now() };
    store.saveRecap(r);
    store.setKv('recap_failure', null);
    bus.emit({ type: 'recap', recap: r });
    return r;
  } catch (err) {
    const error = `${(err instanceof Error ? err.message : String(err)).replace(/[.\s]+$/, '')}. Riprovo tra un'ora, oppure premi Aggiorna.`;
    store.setKv('recap_failure', { day, at: Date.now(), error } satisfies RecapFailure);
    bus.emit({ type: 'recapError', error });
    throw err;
  } finally {
    bus.emit({ type: 'ciccio', phase: 'idle' });
  }
}

// ── Conversazione con Ciccio ────────────────────────────────────────────────
// Una sessione Claude vera: ricorda la conversazione (resume), risponde in diretta,
// usa i connettori di claude.ai e ha strumenti suoi per vedere e guidare gli agenti.

/** Istruzioni della chat: restano identiche tra un giro e l'altro (cache della conversazione). */
const chatSystem = () => `Sei Ciccio, il braccio destro di ${OWNER}: tieni d'occhio i suoi agenti AI (uno per progetto, cioè per repo git) e gli semplifichi la giornata.

Come parli:
- In italiano, dandogli del tu, come un collega sveglio e simpatico in chat. Caldo, diretto, mai burocratico.
- Prima la cosa che conta, poi i dettagli solo se servono. Risposte brevi: spesso le ascolta a voce.
- Se non sai una cosa, controlla con i tuoi strumenti prima di rispondere; non inventare.

Come scrivi in chat (${OWNER} legge di corsa, spesso dal telefono):
- Messaggi corti. Prima riga: l'esito in una frase.
- Poi, se serve, pochi punti elenco brevi (una riga ciascuno), con il grassetto solo sulla parola chiave.
- Niente tabelle, niente titoli, niente blocchi di codice se non sono codice vero; i nomi di file o comandi tra backtick solo quando servono.
- Se hai domande, mettile in fondo, numerate, ognuna risolvibile con un sì/no o due parole.
- Quando ti serve una scelta di ${OWNER} tra poche alternative, usa AskUserQuestion: gli compare una finestra con le opzioni e risponde con un tocco.

Cosa puoi fare:
- Vedere come stanno gli agenti (strumento agenti), cosa è cambiato (novita), leggere le loro chat (chat_agente) e i loro STATUS.md, leggere i file dei progetti (Read, Glob, Grep: i repo sono nella cartella di lavoro).
- Scrivere a un agente per conto di ${OWNER} (scrivi_ad_agente): riscrivi la richiesta come istruzione chiara e completa, poi digli a chi l'hai passata e cosa gli hai chiesto.
- Fermare un agente (ferma_agente) o una chat (ferma_chat) se ${OWNER} lo chiede.
- Creare un progetto nuovo da zero (crea_progetto): repo su GitHub, clone sul server, prima chat.
- Gestire le chat: aprirne di nuove (crea_chat), rinominarle, archiviarle, sbloccarle, cambiare livello, modello ed effort (imposta_chat).
- Gestire i progetti: nome, connettori e strumenti del PC (imposta_progetto), regole "consenti sempre" (regole_progetto).
- Permessi: vedere quelli in attesa (permessi_in_attesa) e rispondere (rispondi_permesso) quando ${OWNER} te lo chiede.
- Impostazioni dell'app (impostazioni_app), riepilogo (aggiorna_riepilogo), progetti nuovi (sincronizza_progetti), uso dell'abbonamento (uso_claude), PC collegati (pc_collegati).
- Routine (routine): messaggi che partono da soli verso un progetto a orari fissi (es. «ogni lunedì alle 8 fai il punto delle PR»). Le elenchi, le metti in pausa, le lanci subito o le togli; crearne una la conferma ${OWNER}.
Alcune azioni (alzare un livello ad Auto o Ignora, aggiungere regole, consentire permessi) le conferma ${OWNER} con un tocco: chiedile pure, il sistema gli mostra la richiesta.
- Usare i connettori di ${OWNER} (posta, calendario, Notion e gli altri strumenti mcp__ disponibili). Le letture vanno da sole; per azioni che inviano, creano o modificano qualcosa fuori, ${OWNER} conferma nella chat.
- Cercare sul web (WebSearch).

Tu e le chat: le chat non si parlano tra loro, passa tutto da te.
- Con scrivi_ad_agente e aspetta_risposta: true, quando quella chat finisce il giro ti arriva la sua risposta («[Risposta di …]») e decidi tu il passo dopo: passarla a un'altra chat, rispondere all'agente o dire a ${OWNER} il risultato in una frase. Usalo solo quando devi davvero continuare tu (passaggi tra progetti, risultati da riportare); per un compito semplice no, a ${OWNER} arriva comunque l'avviso.
- Un agente può scriverti («[Messaggio da …]»): rispondigli con scrivi_ad_agente in quella chat, coinvolgi un'altra chat o chiedi a ${OWNER}. Per sì/no di ${OWNER}, chiedi a lui: non decidere al suo posto.

Avvisi: quando un agente finisce un giro o chiede un permesso, il sistema avvisa ${OWNER} a nome tuo nella tua chat; quegli avvisi ti arrivano come contesto nel messaggio successivo. Se ${OWNER} risponde a un avviso ("digli di sì", "fagli aprire la PR"), scrivi a quella chat con scrivi_ad_agente indicando la chat.

Cosa non fai: non scrivi codice nei repo (lo fanno gli agenti) e non approvi permessi al posto di ${OWNER}.

Quando ti parla a voce (nel messaggio c'è «[A voce]»): sei il suo assistente personale al telefono, non una chat.
- Rispondi come parleresti: frasi brevi e naturali, niente elenchi, grassetti, titoli, emoji, link o codice. Numeri e orari detti a parole come li diresti.
- Brevissimo, come una risposta al telefono: una o due frasi, al massimo una trentina di parole in tutto. Prima l'esito o la risposta, niente premesse, niente riepiloghi di quello che ha chiesto.
- Se c'è altro, non elencarlo: chiedi «vuoi i dettagli?» o di' che glieli lasci scritti in chat. Riassumi sempre: tre agenti si dicono «tre agenti, uno fermo», non uno per uno.
- Una domanda alla volta, alla fine, a cui si risponde a voce in due parole. Niente AskUserQuestion: chiedi a voce.
- Il testo arriva da un riconoscimento vocale e può avere parole storpiate (nomi di progetti, termini tecnici): interpreta con buon senso; se un nome non torna e conta, chiedi conferma ripetendo quello che hai capito.
- Se devi controllare qualcosa con gli strumenti, fallo pure, ma senza annunciarlo: lo dice già il sistema.`;

/** Segno dei messaggi detti a voce: il giro usa il modello della voce e le regole del parlato. */
export const VOICE_TAG = '[A voce] ';

function findAgent(name: string): string | null {
  const q = name.trim().toLowerCase();
  const rows = store.agents();
  return (rows.find((r) => r.id.toLowerCase() === q)
    ?? rows.find((r) => (r.display_name ?? '').toLowerCase() === q)
    ?? rows.find((r) => r.id.toLowerCase().includes(q) || (r.display_name ?? '').toLowerCase().includes(q)))?.id ?? null;
}

/** Chat di un progetto per id o titolo (anche parziale); senza riferimento, la più recente. */
function findChat(agente: string, ref?: string) {
  const id = findAgent(agente);
  if (!id) return `Non trovo un agente "${agente}".`;
  const chats = store.chats(id, true);
  if (!chats.length) return `${id} non ha chat.`;
  if (!ref) return chats.find((c) => !c.archived) ?? chats[0];
  const q = ref.toLowerCase();
  return chats.find((c) => c.id === ref) ?? chats.find((c) => c.title.toLowerCase() === q) ?? chats.find((c) => c.title.toLowerCase().includes(q))
    ?? `Nessuna chat "${ref}" in ${id}. Chat: ${chats.filter((c) => !c.archived).map((c) => `"${c.title}"`).join(', ')}`;
}

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const ciccioTools = createSdkMcpServer({
  name: 'ciccio',
  version: '1.0.0',
  tools: [
    tool('agenti', 'Situazione di tutti gli agenti: stato, ultima riga, ultima attività, estratto di STATUS.md.', {}, async () => textResult(situation() || 'Nessun agente.')),
    tool('chat_agente', "Chat di un progetto: senza 'chat' elenca le chat e mostra gli ultimi messaggi della più recente.", {
      agente: z.string().describe(`id del repo o nome dato da ${OWNER}`),
      chat: z.string().optional().describe('titolo (o parte) o id della chat'),
      quanti: z.number().int().min(1).max(60).optional(),
    }, async ({ agente, chat, quanti }) => {
      const id = findAgent(agente);
      if (!id) return textResult(`Non trovo un agente "${agente}".`);
      const chats = store.chats(id);
      if (!chats.length) return textResult(`${id} non ha ancora chat.`);
      const c = chat ? chats.find((x) => x.id === chat || x.title.toLowerCase().includes(chat.toLowerCase())) : chats[0];
      if (!c) return textResult(`Nessuna chat "${chat}" in ${id}. Chat: ${chats.map((x) => x.title).join(', ')}`);
      // Il ragionamento dell'agente resta fuori: è lungo e non serve a Ciccio.
      const msgs = store.messages(c.id, (quanti ?? 20) * 2).filter((m) => m.role !== 'thinking').slice(-(quanti ?? 20));
      const list = `Chat di ${id}: ${chats.map((x) => `"${x.title}"`).join(', ')}\nUltimi messaggi di "${c.title}":\n`;
      return textResult(list + (msgs.map((m) => `[${new Date(m.ts).toLocaleString('it-IT', { timeZone: config.tz })}] ${m.role}: ${m.text.slice(0, 1200)}`).join('\n') || 'Chat vuota.'));
    }),
    tool('novita', "Cosa è cambiato nelle chat degli agenti dall'ultima volta che hai controllato (o nelle ultime N ore): risposte nuove, giri finiti, permessi in attesa, errori, chi lavora adesso.", {
      ore: z.number().min(0.1).max(168).optional().describe("finestra in ore; senza, dall'ultimo controllo"),
    }, async ({ ore }) => {
      const since = ore ? Date.now() - ore * 3_600_000 : (store.getKv<number>('ciccio_lastcheck') ?? Date.now() - 24 * 3_600_000);
      store.setKv('ciccio_lastcheck', Date.now());
      const lines: string[] = [];
      for (const a of allAgents()) {
        if (a.hidden) continue;
        for (const c of a.chats) {
          const recent = store.messages(c.id, 60).filter((m) => m.ts > since && (m.role === 'agent' || m.role === 'error'));
          if (!recent.length && !c.running && !c.pendingApprovals) continue;
          const last = recent[recent.length - 1];
          lines.push(`- ${a.id} · "${c.title}" · ${c.running ? 'al lavoro' : c.status}${c.pendingApprovals ? ` · ${c.pendingApprovals} permessi in attesa` : ''}${last ? ` · ultima risposta: ${last.text.replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
        }
      }
      return textResult(lines.length ? lines.join('\n') : 'Niente di nuovo.');
    }),
    tool('status_md', "STATUS.md completo di un agente.", { agente: z.string() }, async ({ agente }) => {
      const id = findAgent(agente);
      const row = id ? store.agent(id) : undefined;
      if (!row) return textResult(`Non trovo un agente "${agente}".`);
      return textResult(readStatusMd(row.path)?.raw ?? 'Questo progetto non ha STATUS.md.');
    }),
    tool('scrivi_ad_agente', `Manda un messaggio a un agente da parte di ${OWNER}: va nella chat più recente del progetto, in una chat precisa o in una nuova.`, {
      agente: z.string(),
      messaggio: z.string().min(1).describe("istruzione chiara e completa per l'agente"),
      chat: z.string().optional().describe('titolo (o parte) o id di una chat esistente'),
      nuova_chat: z.boolean().optional().describe('true per aprire una chat nuova (lavoro separato da quello in corso)'),
      aspetta_risposta: z.boolean().optional().describe('true se ti serve la risposta: a fine giro della chat ti arriva e continui tu'),
    }, async ({ agente, messaggio, chat, nuova_chat, aspetta_risposta }) => {
      const id = findAgent(agente);
      if (!id) return textResult(`Non trovo un agente "${agente}". Agenti: ${store.agents().map((r) => r.id).join(', ')}`);
      const target = chat ? store.chats(id).find((x) => x.id === chat || x.title.toLowerCase().includes(chat.toLowerCase())) : undefined;
      if (chat && !target) return textResult(`Nessuna chat "${chat}" in ${id}.`);
      const r = sendToAgent(id, messaggio, 'ciccio', { chatId: target?.id, newChat: nuova_chat });
      if (aspetta_risposta) waitFor(r.chatId, messaggio);
      return textResult(`Mandato a ${id}, chat "${r.title}": ${r.result === 'started' ? 'è partito' : 'è in coda, parte appena si libera'}.${aspetta_risposta ? ' Quando finisce il giro ti arriva la risposta.' : ''}`);
    }),
    // ── Orchestrazione: chat, progetti, permessi, impostazioni dell'app ──────────
    tool('crea_progetto', "Crea un progetto nuovo: repo privato su GitHub, clone sul server, primo commit e prima chat (con un primo messaggio all'agente, se c'è). Il nome è lo slug del repo.", {
      nome: z.string().describe('es. sito-nuovo (minuscole, cifre, - _ .)'),
      descrizione: z.string().optional(),
      messaggio: z.string().optional().describe("cosa deve fare l'agente per iniziare"),
    }, async ({ nome, descrizione, messaggio }) => {
      try {
        const r = await createProject({ name: nome, description: descrizione, message: messaggio });
        return textResult(`Progetto ${r.agentId} creato: ${r.url}. Prima chat aperta${messaggio ? ' e agente al lavoro' : ''}.`);
      } catch (e) {
        return textResult(`Non ho creato il progetto: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    tool('crea_chat', "Apre una chat nuova in un progetto (lavoro separato da quello in corso) e, se c'è, le manda il primo messaggio.", {
      agente: z.string(),
      titolo: z.string().optional(),
      messaggio: z.string().optional().describe("istruzione per l'agente; senza, la chat resta vuota"),
    }, async ({ agente, titolo, messaggio }) => {
      const id = findAgent(agente);
      if (!id) return textResult(`Non trovo un agente "${agente}".`);
      const chat = createChat(id, titolo);
      if (messaggio) sendToChat(chat.id, messaggio, 'ciccio');
      return textResult(`Chat "${store.chat(chat.id)?.title}" aperta in ${id}${messaggio ? ' e messaggio mandato' : ''}. id: ${chat.id}`);
    }),
    tool('rinomina_chat', 'Cambia il titolo di una chat.', { agente: z.string(), chat: z.string(), titolo: z.string().min(1) }, async ({ agente, chat, titolo }) => {
      const c = findChat(agente, chat);
      if (typeof c === 'string') return textResult(c);
      renameChat(c.id, titolo);
      return textResult(`Rinominata in "${titolo}".`);
    }),
    tool('archivia_chat', "Archivia una chat (sparisce dall'elenco, i messaggi restano; scrivendole torna).", { agente: z.string(), chat: z.string() }, async ({ agente, chat }) => {
      const c = findChat(agente, chat);
      if (typeof c === 'string') return textResult(c);
      archiveChat(c.id);
      return textResult(`Chat "${c.title}" archiviata.`);
    }),
    tool('ferma_chat', 'Ferma una chat al lavoro (o la toglie dalla coda).', { agente: z.string(), chat: z.string().optional() }, async ({ agente, chat }) => {
      const c = findChat(agente, chat);
      if (typeof c === 'string') return textResult(c);
      return textResult(stopChat(c.id) ? `"${c.title}" fermata.` : `"${c.title}" non stava lavorando.`);
    }),
    tool('contesto_chat', "Contesto di una chat (quanto è piena la sessione) e, se serve, la comprime o le fa ripartire una sessione nuova.", {
      agente: z.string(),
      chat: z.string().optional(),
      azione: z.enum(['leggi', 'comprimi', 'nuova_sessione']).optional(),
    }, async ({ agente, chat, azione }) => {
      const c = findChat(agente, chat);
      if (typeof c === 'string') return textResult(c);
      if (azione === 'comprimi') return textResult(compactChat(c.id) === 'empty' ? 'La chat non ha ancora una sessione da comprimere.' : `Comprimo "${c.title}".`);
      if (azione === 'nuova_sessione') { newSession(c.id); return textResult(`"${c.title}" riparte con una sessione nuova.`); }
      return textResult(c.context_used && c.context_max ? `"${c.title}": ${Math.round((c.context_used / c.context_max) * 100)}% del contesto (${Math.round(c.context_used / 1000)}k di ${Math.round(c.context_max / 1000)}k token).` : `"${c.title}": contesto non ancora misurato.`);
    }),
    tool('sblocca_chat', "Toglie l'errore che tiene bloccata una chat.", { agente: z.string(), chat: z.string().optional() }, async ({ agente, chat }) => {
      const c = findChat(agente, chat);
      if (typeof c === 'string') return textResult(c);
      clearError(c.id);
      return textResult(`"${c.title}" sbloccata.`);
    }),
    tool('imposta_chat', `Cambia livello di autorizzazione (manual, edits, auto, bypass), modello o effort di una chat. Alzare il livello ad auto o bypass lo conferma ${OWNER}.`, {
      agente: z.string(),
      chat: z.string().optional(),
      livello: z.enum(['manual', 'edits', 'auto', 'bypass']).optional(),
      modello: z.enum(MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
      effort: z.enum(EFFORTS as [Effort, ...Effort[]]).optional(),
    }, async ({ agente, chat, livello, modello, effort }) => {
      const c = findChat(agente, chat);
      if (typeof c === 'string') return textResult(c);
      if (livello) setPermission(c.id, livello);
      if (modello || effort) setModel(c.id, modello ?? c.model, effort ?? c.effort);
      const now = store.chat(c.id)!;
      return textResult(`"${now.title}": livello ${now.permission}, modello ${now.model ?? 'predefinito'}, effort ${now.effort ?? 'predefinito'}.`);
    }),
    tool('imposta_progetto', `Cambia il nome mostrato di un progetto e accende o spegne connettori di claude.ai e strumenti del PC per tutte le sue chat. Accenderli lo conferma ${OWNER}.`, {
      agente: z.string(),
      nome: z.string().optional().describe('stringa vuota = torna al nome del repo'),
      connettori: z.boolean().optional(),
      strumenti_pc: z.boolean().optional(),
      nascosto: z.boolean().optional().describe('true = nascondi il progetto in Ciccio (vecchio, chiuso o non interessa); false = rimostralo'),
    }, async ({ agente, nome, connettori, strumenti_pc, nascosto }) => {
      const id = findAgent(agente);
      if (!id) return textResult(`Non trovo un agente "${agente}".`);
      if (nome != null) renameAgent(id, nome);
      if (connettori != null) setConnectors(id, connettori);
      if (strumenti_pc != null) setPcTools(id, strumenti_pc);
      if (nascosto != null) setHidden(id, nascosto);
      const r = store.agent(id)!;
      return textResult(`${id}: nome "${r.display_name ?? id}", connettori ${r.connectors ? 'accesi' : 'spenti'}, strumenti del PC ${r.pc_tools ? 'accesi' : 'spenti'}${r.hidden ? ', nascosto' : ''}.`);
    }),
    tool('regole_progetto', `Regole "consenti sempre" di un progetto: le elenca, ne aggiunge (lo conferma ${OWNER}) o ne toglie.`, {
      agente: z.string(),
      aggiungi: z.string().optional().describe('es. "Bash:npm test" oppure il nome di uno strumento'),
      togli: z.string().optional(),
    }, async ({ agente, aggiungi, togli }) => {
      const id = findAgent(agente);
      if (!id) return textResult(`Non trovo un agente "${agente}".`);
      if (togli) removeRule(id, togli);
      if (aggiungi) addRule(id, aggiungi);
      const rules = allowRules(id);
      return textResult(rules.length ? `Regole di ${id}: ${rules.join(', ')}` : `${id} non ha regole "consenti sempre".`);
    }),
    tool('permessi_in_attesa', `Permessi che gli agenti stanno aspettando da ${OWNER}, con il loro id.`, {}, async () => {
      const list = store.pendingApprovals().filter((a) => a.chatId !== CICCIO_THREAD);
      if (!list.length) return textResult('Nessun permesso in attesa.');
      // Le domande a scelte le risponde l'utente dalla finestra nella chat: qui solo per sapere che ci sono.
      return textResult(list.map((a) => `- ${a.tool === ASK_TOOL ? `domanda (risponde ${OWNER} dalla chat)` : `id ${a.id}`} · ${a.agentId} · "${store.chat(a.chatId)?.title ?? ''}" · ${a.summary}`).join('\n'));
    }),
    tool('rispondi_permesso', `Risponde a un permesso in attesa di un agente. Per consentire serve la conferma di ${OWNER}; rifiutare no.`, {
      id: z.string(),
      consenti: z.boolean(),
      sempre: z.boolean().optional().describe('consenti sempre per il progetto'),
    }, async ({ id, consenti, sempre }) => {
      // Chiavi SSH, segreti di 1Password e programmi di sistema: solo l'utente, dalla card. Rifiutare invece si può.
      const a = store.pendingApprovals().find((x) => x.id === id);
      if (consenti && a && ONLY_OWNER.has(a.tool)) return textResult(`Questo permesso (chiavi SSH, segreto di 1Password, programma di sistema, strumento nuovo o routine di un agente) lo approva solo ${OWNER}, dalla card nella chat: diglielo.`);
      return textResult(decideApproval(id, consenti, !!sempre) ? `Permesso ${consenti ? 'consentito' : 'rifiutato'}.` : 'Quel permesso non è più in attesa.');
    }),
    tool('impostazioni_app', "Legge o cambia le impostazioni dell'app: modello ed effort di Ciccio, avvisi (noticeDone, noticeApprovals, noticeErrors), voiceReplies, valori delle chat nuove (defaultPermission, defaultModel, defaultEffort), subagentModels (modelli consentiti ai sub-agent degli agenti, almeno uno tra haiku, sonnet, opus, fable), maxActive (chat al lavoro insieme, 1-10), recapHour (0-23). Senza 'modifiche' le legge.", {
      modifiche: z.record(z.string(), z.unknown()).optional(),
    }, async ({ modifiche }) => {
      if (!modifiche) return textResult(JSON.stringify(settings(), null, 2));
      const r = updateSettings(modifiche, false);
      return textResult(`Fatto.${r.rejected.length ? ` Non applicati: ${r.rejected.join(', ')}.` : ''}\n${JSON.stringify(r.settings, null, 2)}`);
    }),
    tool('aggiorna_riepilogo', 'Rifà adesso il riepilogo della situazione (quello del mattino).', {}, async () => {
      const r = await recap(true);
      return textResult(`${r.headline}\n${r.lines.map((l) => `- ${l.text}`).join('\n')}`);
    }),
    tool('sincronizza_progetti', 'Rilegge la cartella dei progetti: aggiunge i repo nuovi.', {}, async () => textResult(`Progetti: ${syncProjects().length}.`)),
    tool('uso_claude', "Uso dell'abbonamento Claude: finestra di 5 ore e settimanale con l'ora del ripristino.", {}, async () => {
      if (!onSubscription()) return textResult('Il server non ha il login di claude.ai: le sessioni non partono finché non si accede.');
      const u = currentUsage();
      if (!u) return textResult('Dato non ancora disponibile.');
      const w = (x: { utilization: number; resetsAt: number } | null) => (x ? `${Math.round(x.utilization * 100)}% (si azzera ${new Date(x.resetsAt).toLocaleString('it-IT', { timeZone: config.tz })})` : 'n.d.');
      return textResult(`5 ore: ${w(u.fiveHour)} · settimana: ${w(u.sevenDay)}`);
    }),
    tool('pc_collegati', `PC di ${OWNER} con il companion (Mac, Windows): chi è acceso e quali strumenti locali offre.`, {}, async () => {
      const list = companions();
      if (!list.length) return textResult('Nessun PC registrato.');
      return textResult(list.map((c) => `- ${c.name}: ${c.online ? 'acceso' : 'spento'}${c.servers?.length ? ` · ${c.servers.map((s) => `${s.name} (${s.status}, ${s.tools.length} strumenti)`).join(', ')}` : ''}`).join('\n'));
    }),
    tool('strumenti_progetto', `Strumenti su misura di un progetto (comandi del server e server MCP proposti dagli agenti e approvati da ${OWNER}): li elenca o ne toglie uno. Aggiungerli no: li propone l'agente e li approva ${OWNER}.`, {
      agente: z.string(),
      togli: z.string().optional().describe('nome dello strumento da togliere'),
    }, async ({ agente, togli }) => {
      const id = findAgent(agente);
      if (!id) return textResult(`Non trovo un agente "${agente}".`);
      if (togli && !removeProjectTool(id, togli)) return textResult(`${id} non ha uno strumento "${togli}".`);
      const list = projectToolViews(id).map((t) => `- ${t.name} (${t.kind === 'mcp' ? 'server MCP' : 'comando'}): ${t.description} · ${t.detail} · usato ${t.uses} volte`);
      return textResult(`${togli ? `Tolto ${togli}. ` : ''}${list.length ? `Strumenti di ${id}:\n${list.join('\n')}` : `${id} non ha strumenti su misura.`}`);
    }),
    tool('routine', `Routine: messaggi che il server manda da solo a un progetto a orari fissi (cron a 5 campi nel fuso ${config.tz}: minuto ora giorno mese giorno-settimana, es. '0 8 * * 1' = ogni lunedì alle 8, '30 7 * * 1-5' = feriali alle 7:30). Ogni esecuzione apre una chat nuova senza contesto, a meno di indicare una chat fissa. azione: elenca (senza agente: tutte), crea (la conferma ${OWNER}), pausa, riprendi, lancia (subito), togli.`, {
      azione: z.enum(['elenca', 'crea', 'pausa', 'riprendi', 'lancia', 'togli']),
      agente: z.string().optional().describe('progetto: serve per crea, facoltativo altrimenti'),
      routine: z.string().optional().describe('nome (anche parziale) o id della routine: per pausa, riprendi, lancia, togli'),
      nome: z.string().max(60).optional().describe('crea: nome breve'),
      testo: z.string().max(8000).optional().describe(`crea: il messaggio da mandare all'agente, chiaro e completo come se lo scrivesse ${OWNER}`),
      quando: z.string().optional().describe(`crea: cron a 5 campi, fuso ${config.tz}`),
      chat: z.string().optional().describe('crea: titolo o id di una chat fissa; senza, chat nuova a ogni esecuzione'),
    }, async ({ azione, agente, routine, nome, testo, quando, chat }) => {
      const id = agente ? findAgent(agente) : null;
      if (agente && !id) return textResult(`Non trovo un agente "${agente}".`);
      const when = (ms: number) => new Date(ms).toLocaleString('it-IT', { timeZone: config.tz });
      const line = (r: RoutineView) => `- ${r.name} (${r.agentId}) · ${r.when}${r.enabled ? '' : ' · in pausa'} · ${r.total} esecuzioni`
        + `${r.last ? ` · ultima: ${r.last.status}` : ''}${r.nextRun ? ` · prossima ${when(r.nextRun)}` : ''}`
        + ` · 30 giorni: ${Math.round((r.month.tokensIn + r.month.tokensOut) / 1000)}k token, ${r.month.costUsd.toFixed(2)} $ equivalenti`;
      try {
        if (azione === 'elenca') {
          const list = routineViews(id ?? undefined);
          return textResult(list.length ? list.map(line).join('\n') : 'Nessuna routine.');
        }
        if (azione === 'crea') {
          if (!id || !nome || !testo || !quando) return textResult('Per creare servono agente, nome, testo e quando.');
          const c = chat ? findChat(id, chat) : null;
          if (typeof c === 'string') return textResult(c);
          return textResult(`Routine creata: ${line(createRoutine({ agentId: id, name: nome, text: testo, cron: quando, chatId: c?.id ?? null }, 'ciccio'))}`);
        }
        const r = routine ? findRoutine(routine, id ?? undefined) : undefined;
        if (!r) return textResult(`Non trovo la routine "${routine ?? ''}".`);
        if (azione === 'pausa' || azione === 'riprendi') return textResult(`Fatto: ${line(updateRoutine(r.id, { enabled: azione === 'riprendi' }))}`);
        if (azione === 'togli') { removeRoutine(r.id); return textResult(`Routine "${r.name}" tolta.`); }
        const res = fireRoutine(r.id, true);
        return textResult(res === 'waiting' ? `"${r.name}" sta ancora girando: la prossima parte appena finisce.` : `"${r.name}" ${res === 'queued' ? 'è in coda' : res === 'skipped' ? 'saltata' : 'partita'}.`);
      } catch (e) {
        return textResult(`Non fatto: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    tool('ferma_agente', 'Ferma un agente al lavoro (o lo toglie dalla coda).', { agente: z.string() }, async ({ agente }) => {
      const id = findAgent(agente);
      if (!id) return textResult(`Non trovo un agente "${agente}".`);
      return textResult(stopAgent(id) ? `${id} fermato.` : `${id} non stava lavorando.`);
    }),
  ],
});

/**
 * Le azioni di Ciccio che danno più autonomia agli agenti le conferma l'utente nella chat:
 * alzare il livello di una chat ad Auto o Ignora, aggiungere regole "consenti sempre",
 * consentire un permesso, alzare il livello predefinito delle chat nuove, accendere connettori o strumenti del PC.
 */
function ciccioNeedsOk(tool: string, input: Record<string, unknown>): string | null {
  const risky = (v: unknown) => v === 'auto' || v === 'bypass';
  if (tool === 'imposta_chat' && risky(input.livello)) return `Ciccio vuole mettere la chat in livello ${input.livello === 'bypass' ? 'Ignora autorizzazioni' : 'Auto'}`;
  if (tool === 'regole_progetto' && input.aggiungi) return 'Ciccio vuole aggiungere una regola "consenti sempre"';
  // La card mostra cosa consente, a chi e la regola che salverebbe «sempre» (il riepilogo lo prepara agents.ts).
  if (tool === 'rispondi_permesso' && input.consenti === true) return `Ciccio vuole consentire un permesso a un agente${input.sempre === true ? ' anche per le prossime volte' : ''}`;
  // Connettori di claude.ai (posta, calendario…) e strumenti dei PC danno agli agenti accesso a dati e azioni fuori dal repo.
  if (tool === 'imposta_progetto' && (input.connettori === true || input.strumenti_pc === true)) {
    const what = [input.connettori === true ? 'i connettori di claude.ai' : '', input.strumenti_pc === true ? 'gli strumenti del PC' : ''].filter(Boolean).join(' e ');
    return `Ciccio vuole accendere ${what} per tutte le chat di ${String(input.agente ?? 'un progetto')}`;
  }
  if (tool === 'impostazioni_app' && input.modifiche && risky((input.modifiche as Record<string, unknown>).defaultPermission)) return 'Ciccio vuole alzare il livello predefinito delle chat nuove';
  // Una routine nuova consuma da sola, a orari fissi, anche quando l'utente non guarda.
  if (tool === 'routine' && input.azione === 'crea') return `Ciccio vuole creare una routine (${describeCron(String(input.quando ?? ''))})`;
  return null;
}

let chatState: Running | null = null;
const pendingNotes: string[] = [];
/** Pausa oltre cui la cache è scaduta (dura un'ora) e conviene una sessione nuova. */
const CICCIO_IDLE_MS = 60 * 60_000;
/** Contesto oltre cui Ciccio riparte leggero: ogni chiamata rilegge tutto il contesto. */
const CICCIO_MAX_CONTEXT = 150_000;

// ── Avvisi spontanei ────────────────────────────────────────────────────
// Quando una chat di un agente finisce un giro o chiede un permesso, Ciccio lo dice all'utente
// nella sua chat, a meno che l'utente non stia già guardando quella chat.

function notice(text: string, meta: NoticeMeta) {
  const m = store.addMessage(CICCIO, 'agent', text, meta);
  bus.emit({ type: 'message', message: m });
  pendingNotes.push(`- ${meta.agentId} · "${meta.chatTitle}": ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (pendingNotes.length > 20) pendingNotes.shift();
}

/** Riassunto di due righe dell'ultimo giro, scritto da Haiku nel tono di Ciccio. */
async function summarize(agentName: string, chatTitle: string, reply: string): Promise<string> {
  let out = '';
  try {
    const q = query({
      prompt: `Sei Ciccio, l'assistente di ${OWNER}. L'agente "${agentName}" ha appena finito un giro nella chat "${chatTitle}". Ecco la sua risposta:\n"""${reply.slice(0, 4000)}"""\n\nScrivi a ${OWNER} un avviso da notifica del telefono: al massimo 150 caratteri in tutto, in italiano, col tu. Prima frase: cosa ha fatto, in poche parole, cominciando con «${agentName} ha…». Se all'agente serve qualcosa da ${OWNER}, seconda frase che comincia con «Serve da te:» e dice l'azione concreta (es. «Serve da te: dirgli dove mettere la pagina di debug»). Niente dettagli tecnici, nomi di file, saluti, elenchi, markdown, virgolette o backtick.`,
      options: { cwd: config.dataDir, model: 'claude-haiku-5-5', maxTurns: 1, settingSources: [], tools: [], permissionMode: 'dontAsk', env: { ...claudeEnv, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } },
    });
    for await (const m of q) { recordUsage(m); if (m.type === 'result' && m.subtype === 'success') out = m.result; }
  } catch { /* si usa la prima riga della risposta */ }
  return plainText(out.trim() || reply.split('\n').find((l) => l.trim()) || 'Ha finito.');
}

// ── Ciccio ↔ chat ───────────────────────────────────────────────────────
// Ciccio aspetta la risposta di una chat (scrivi_ad_agente con aspetta_risposta) o riceve un messaggio da un agente
// (scrivi_a_ciccio): in entrambi i casi parte un giro di Ciccio, solo allora. Un tetto per ora evita i botta e
// risposta senza fine tra Ciccio e un agente, che consumerebbero da soli.

type Wait = { asked: string; at: number };
const waits = (): Record<string, Wait> => store.getKv<Record<string, Wait>>('ciccio_waits') ?? {};
const AUTO_TURNS_PER_HOUR = 12;
let autoTurns: number[] = [];

function waitFor(chatId: string, asked: string) {
  store.setKv('ciccio_waits', { ...waits(), [chatId]: { asked: asked.slice(0, 300), at: Date.now() } });
}

/** Un giro di Ciccio partito da una chat: false se il tetto orario è pieno (allora resta l'avviso normale). */
function autoTurn(note: string, prompt: string): boolean {
  const now = Date.now();
  autoTurns = autoTurns.filter((t) => now - t < 60 * 60_000);
  if (autoTurns.length >= AUTO_TURNS_PER_HOUR) return false;
  autoTurns.push(now);
  bus.emit({ type: 'message', message: store.addMessage(CICCIO, 'tool', note) });
  continueCiccio(prompt);
  return true;
}

function deliverReply(e: { chatId: string; agentId: string; aborted: boolean; error: string | null }): boolean {
  const all = waits();
  const w = all[e.chatId];
  if (!w) return false;
  delete all[e.chatId];
  store.setKv('ciccio_waits', all);
  if (e.aborted) return false;
  const chat = store.chat(e.chatId);
  const agent = store.agent(e.agentId);
  const name = agent?.display_name?.trim() || e.agentId;
  const reply = e.error ? `Si è fermato con un errore: ${e.error.split('\n')[0]}`
    : store.messages(e.chatId, 80).filter((m) => m.role === 'agent' && m.ts >= w.at).map((m) => m.text).join('\n\n').slice(-4000);
  return autoTurn(`risposta di ${name} arrivata, la guardo`,
    `[Risposta di ${name} (chat "${chat?.title ?? ''}") a quello che gli avevi chiesto: «${w.asked}»]\n${reply || '(nessun testo)'}\n\nDecidi tu il passo dopo. Se ${OWNER} deve saperlo, diglielo in una o due frasi.`);
}

export function startNotices() {
  // Un agente scrive a Ciccio: parte un giro di Ciccio con il messaggio (se il tetto orario lo permette).
  agentEvents.onToCiccio((m) => {
    const agent = store.agent(m.agentId);
    const name = agent?.display_name?.trim() || m.agentId;
    const ok = autoTurn(`messaggio da ${name}, lo guardo`,
      `[Messaggio da ${name} (chat "${m.chatTitle}")]\n${m.text.slice(0, 3000)}\n\nSe serve rispondergli usa scrivi_ad_agente su quella chat; se serve una decisione di ${OWNER}, chiedigliela in una frase.`);
    if (!ok) notice(plainText(`${name} ti ha scritto, ma Ciccio ha già fatto molti giri automatici in quest'ora: ${m.text}`), { kind: 'notice', agentId: m.agentId, chatId: m.chatId, chatTitle: m.chatTitle, tone: 'wait' });
  });
  agentEvents.onFinished((e) => {
    // Ciccio aspettava questa risposta: la riceve lui e decide il passo dopo (niente avviso doppio all'utente).
    if (deliverReply(e)) return;
    if (e.aborted || isViewing(e.chatId)) return;
    const prefs = settings();
    if (e.error ? !prefs.noticeErrors : !prefs.noticeDone) return;
    const chat = store.chat(e.chatId);
    const agent = store.agent(e.agentId);
    if (!chat || !agent || agent.hidden) return;
    // Le esecuzioni delle routine si riconoscono dal nome davanti.
    const name = `${e.routine ? `⏱ ${e.routine.name} · ` : ''}${agent.display_name?.trim() || agent.id}`;
    const meta: NoticeMeta = { kind: 'notice', agentId: e.agentId, chatId: e.chatId, chatTitle: chat.title, tone: e.error ? 'block' : 'done' };
    if (e.error) { notice(plainText(`${name} si è fermato con un errore: ${e.error.split('\n')[0]}`), meta); return; }
    const reply = store.messages(e.chatId, 80).filter((m) => m.role === 'agent').slice(-2).map((m) => m.text).join('\n\n');
    if (!reply) return;
    const asks = (chat.last_result ?? '').trim().endsWith('?');
    void summarize(name, chat.title, reply).then((text) => notice(text, { ...meta, tone: asks ? 'wait' : 'done' }));
  });
  // Avvisi che non vengono da un giro (es. una routine saltata per la soglia sull'uso).
  agentEvents.onNotice((n) => {
    const agent = store.agent(n.agentId);
    if (!agent || agent.hidden || !settings().noticeErrors) return;
    const chat = (n.chatId ? store.chat(n.chatId) : undefined) ?? store.chats(n.agentId)[0];
    if (!chat) return;
    notice(n.text, { kind: 'notice', agentId: n.agentId, chatId: chat.id, chatTitle: chat.title, tone: n.tone });
  });
  bus.on((ev) => {
    if (ev.type !== 'approval' || ev.approval.status !== 'pending' || ev.approval.chatId === CICCIO_THREAD || isViewing(ev.approval.chatId)) return;
    if (!settings().noticeApprovals) return;
    const chat = store.chat(ev.approval.chatId);
    const agent = store.agent(ev.approval.agentId);
    if (!chat || !agent || agent.hidden) return;
    const name = agent.display_name?.trim() || agent.id;
    const asks = ev.approval.tool === ASK_TOOL;
    // Proposte di strumenti e routine: il nome basta, il comando esatto lo vede nella card della chat.
    const proposal = PROPOSALS.has(ev.approval.tool) || ev.approval.tool === ROUTINE_TOOL
      ? ev.approval.summary.split('\n')[0].replace(/^mcp__\w+?__\w+: /, '').replace(/^strumento /, 'uno strumento ').replace(/^server MCP /, 'un server MCP ').replace(/^routine /, 'una routine ')
      : null;
    // Due righe al massimo, parole normali: cosa vuole fare e cosa devi fare tu (niente nomi di strumenti né JSON).
    notice(asks ? plainText(`${name} ti fa una domanda: ${ev.approval.summary.replace(/^Domanda: /, '')}`)
      : proposal ? plainText(`${name} ti propone ${proposal}. Decidi nella chat.`)
      : plainText(`${name} chiede il permesso di ${plainAction(ev.approval.tool, (ev.approval.input ?? {}) as Record<string, unknown>)}. Decidi nella chat.`),{ kind: 'notice', agentId: agent.id, chatId: chat.id, chatTitle: chat.title, tone: 'wait', approvalId: ev.approval.id });
  });
}
const chatQueue: string[] = [];
/** Testi dei giri che ha chiesto l'utente (gli altri, in coda o no, sono automatici): per i consumi. */
const fromOwner = new Set<string>();

export function ciccioRunning() { return chatState != null; }

/** Giro di Ciccio in corso (per il registro dello spegnimento e il deploy), o null; con i messaggi in coda. */
export function ciccioTurn(): { turn: TurnSnapshot | null; queue: string[] } {
  return { turn: chatState ? turnSnapshot(CICCIO_THREAD, chatState) : null, queue: [...chatQueue] };
}

/** L'utente scrive a Ciccio: la risposta arriva in diretta sul canale degli eventi. */
export function talkToCiccio(text: string, voice = false): 'started' | 'queued' {
  dropTail(CICCIO_THREAD);
  setSuggestion(CICCIO_THREAD, null);
  const userMsg = store.addMessage(CICCIO, 'user', text);
  bus.emit({ type: 'message', message: userMsg });
  const prompt = (voice ? VOICE_TAG : '') + staleNote(CICCIO_THREAD) + text;
  fromOwner.add(prompt);
  return continueCiccio(prompt);
}

/** Un giro di Ciccio senza messaggio nuovo in chat: la ripresa dopo un riavvio o un messaggio rimasto in coda. */
export function continueCiccio(text: string): 'started' | 'queued' {
  if (chatState || isDraining()) { chatQueue.push(text); return 'queued'; }
  void chatTurn(text);
  return 'started';
}

export function stopCiccio(): boolean {
  chatQueue.length = 0;
  // Richieste riproposte dopo un riavvio: fermando Ciccio non c'è più un giro da riprendere.
  const wasParked = !!staleNote(CICCIO_THREAD);
  if (!chatState) return wasParked;
  chatState.abort.abort();
  return true;
}

/** Nuova conversazione: Ciccio dimentica il contesto (i messaggi restano visibili). */
export function resetCiccio() {
  stopCiccio();
  dropTail(CICCIO_THREAD);
  setSuggestion(CICCIO_THREAD, null);
  store.setKv('ciccio_session', null);
  store.setKv('ciccio_context', null);
  bus.emit({ type: 'ciccioContext', context: null });
  const m = store.addMessage(CICCIO, 'tool', 'nuova conversazione');
  bus.emit({ type: 'message', message: m });
}

export function ciccioContext(): ContextInfo | null {
  return store.getKv<ContextInfo>('ciccio_context') ?? null;
}

/** Comprime la conversazione con Ciccio (come /compact). */
export function compactCiccio(): 'started' | 'queued' | 'empty' {
  if (!store.getKv<string>('ciccio_session')) return 'empty';
  bus.emit({ type: 'message', message: store.addMessage(CICCIO, 'tool', 'comprimo la conversazione…') });
  return continueCiccio('/compact');
}

async function chatTurn(prompt: string, retry = true, origin: TurnOrigin = fromOwner.delete(prompt) ? 'utente' : 'ciccio'): Promise<void> {
  const original = prompt;
  const startedAt = Date.now();
  // Giro a voce: il segno resta nel testo (Ciccio sa che deve parlare), modello ed effort sono quelli della voce.
  const voice = prompt.startsWith(VOICE_TAG);
  const state: Running = newRunning(CICCIO_THREAD, CICCIO_THREAD);
  chatState = state;
  // Giro aperto: se all'avvio è ancora qui senza registro dello spegnimento, il server è caduto (restart.ts).
  store.setKv('ciccio_turn_started', Date.now());
  dropTail(CICCIO_THREAD);
  setSuggestion(CICCIO_THREAD, null);
  trackSession(CICCIO_THREAD, state);
  bus.emit({ type: 'ciccio', phase: 'thinking' });
  emitLive(state, true);
  // Un comando a metà messaggio («… e poi /compact») va in testa, come nelle chat degli agenti (commands.ts).
  prompt = hoistCommand(ciccioKey(), prompt);
  const command = prompt.startsWith('/');
  let resume = store.getKv<string>('ciccio_session') ?? undefined;
  // Dopo un'ora di pausa la cache è scaduta: riprendere vorrebbe dire ripagare per intero tutta la conversazione
  // (centinaia di migliaia di token). Meglio una sessione nuova con gli ultimi messaggi come promemoria.
  // Lo stesso quando il contesto è cresciuto troppo: ogni chiamata lo rilegge tutto.
  const lastTurn = store.getKv<number>('ciccio_last_turn') ?? 0;
  const ctx = ciccioContext();
  let recent = '';
  if (settings().ciccioLightSession && resume && !command && ((lastTurn && Date.now() - lastTurn > CICCIO_IDLE_MS) || (ctx && ctx.used > CICCIO_MAX_CONTEXT))) {
    resume = undefined;
    store.setKv('ciccio_session', null);
    store.setKv('ciccio_context', null);
    bus.emit({ type: 'ciccioContext', context: null });
    // Il messaggio appena scritto dall'utente è già salvato: resta fuori dal promemoria.
    const past = store.messages(CICCIO_THREAD, 16).filter((m) => m.role === 'user' || m.role === 'agent').slice(0, -1).slice(-12);
    if (past.length) recent = `[Sessione nuova: ultimi messaggi tra te e ${OWNER}, per contesto]\n${past.map((m) => `${m.role === 'user' ? `${OWNER}` : 'Tu'}: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}\n\n`;
    bus.emit({ type: 'message', message: store.addMessage(CICCIO, 'tool', 'nuova sessione leggera per risparmiare sull\'uso (ricorda gli ultimi messaggi)') });
  }
  const now = new Intl.DateTimeFormat('it-IT', { timeZone: config.tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  // I comandi (/compact) vanno così come sono; ai messaggi si aggiungono ora, PC accesi e avvisi dati nel frattempo,
  // così se l'utente risponde "ok, digli di sì" Ciccio sa a cosa. Stanno nel messaggio e non nelle istruzioni:
  // le istruzioni devono restare identiche, o la cache dell'intera conversazione si perde.
  const notes = command ? [] : pendingNotes.splice(0);
  const skills = settings().ciccioSkills;
  let failed: string | null = null;
  // Gli errori arrivati come risultato li mostra già handleMessage: qui solo quelli senza risultato.
  let gotResult = false;
  const pcServers = pcMcpServers();
  const pcLine = pcPrompt(pcServers) || `- Nessun PC di ${OWNER} acceso con il companion: niente strumenti del PC.`;
  // Giro riuscito: Ciccio si libera al risultato. Il processo resta aperto qualche secondo per il prompt
  // suggerito; quello che succede dopo (errori compresi) non tocca più il giro.
  let settled = false;
  let early = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    store.setKv('ciccio_last_turn', Date.now());
    store.setKv('ciccio_turn_started', null);
    clearPreapproved(CICCIO_THREAD);
    releasePcServers(pcServers);
    state.live = { chatId: CICCIO_THREAD, agentId: CICCIO_THREAD, phase: 'idle', text: '' };
    emitLive(state, true);
    untrackSession(CICCIO_THREAD);
    chatState = null;
    keepTail(CICCIO_THREAD, state.abort);
    bus.emit({ type: 'ciccio', phase: 'idle' });
  };
  if (!command) {
    const head = [`[${now}]`, `[Adesso:\n${pcLine}]`];
    if (notes.length) head.push(`[Avvisi che gli hai dato dall'ultimo messaggio:\n${notes.join('\n')}]`);
    prompt = `${recent}${head.join('\n')}\n\n${prompt}`;
  }
  try {
    const q = query({
      prompt,
      options: {
        cwd: config.projectsDir,
        resume,
        model: voice ? settings().ciccioVoiceModel : settings().ciccioModel,
        effort: voice ? settings().ciccioVoiceEffort : settings().ciccioEffort,
        // In chat il ragionamento si legge (blocco «Ragionamento»); a voce non serve.
        ...(voice ? {} : { thinking: { type: 'adaptive', display: 'summarized' } as const }),
        // Con le skill accese Ciccio legge quelle installate sul server (~/.claude/skills) e può usarle.
        // ToolSearch serve: senza, Claude Code non può tenere da parte gli strumenti dei connettori di claude.ai e li
        // mette tutti in ogni richiesta (oltre 600 strumenti, ~400k token a chiamata: era la voce più pesante di
        // Ciccio). Con ToolSearch li carica uno alla volta quando servono, come fanno gli agenti.
        tools: skills ? ['Read', 'Glob', 'Grep', 'WebSearch', 'ToolSearch', ASK_TOOL, 'Skill'] : ['Read', 'Glob', 'Grep', 'WebSearch', 'ToolSearch', ASK_TOOL],
        mcpServers: { ciccio: ciccioTools, ...pcServers },
        settingSources: skills ? ['user'] : [],
        settings: { autoCompactEnabled: settings().autoCompact, ...(settings().autoCompactWindow ? { autoCompactWindow: settings().autoCompactWindow } : {}), crossSessionInbound: 'refuse' },
        systemPrompt: { type: 'custom', prompt: `${chatSystem()}\n\nPC di ${OWNER} e loro strumenti vanno e vengono: la riga «[Adesso: …]» all'inizio di un messaggio dice cosa c'è in quel momento.`, snapshot: true },
        permissionMode: 'default',
        canUseTool: async (toolName, input, opts) => {
          // Domande a scelte: la finestra sopra il campo di testo, la risposta torna a Ciccio.
          if (toolName === ASK_TOOL) return askQuestion(CICCIO, state, input, opts.signal, opts.toolUseID);
          if (toolName.startsWith('mcp__ciccio__')) {
            const why = ciccioNeedsOk(toolName.slice('mcp__ciccio__'.length), input);
            return why ? askApproval(CICCIO, state, toolName, input, why, opts.signal, opts.toolUseID) : { behavior: 'allow' };
          }
          // Read, Glob e Grep di Ciccio: i repo dei progetti in sola lettura (non ha strumenti che scrivono), niente dati di
          // Ciccio, ciccio.env, token locale o credenziali di Claude. Ciccio legge testo che non viene dall'utente
          // (messaggi degli agenti, STATUS.md, pagine web, risultati dei PC): un'istruzione nascosta lì non deve
          // bastare a fargli leggere un segreto. Stesse zone vietate degli agenti (confine.ts).
          const confined = confine(toolName, input, { project: '', repo: config.projectsDir, dir: config.projectsDir, slug: null });
          if (confined?.action === 'deny') return { behavior: 'deny', message: confined.reason };
          const verdict = decide('auto', toolName, input, config.projectsDir, pcToolHints(toolName));
          if (verdict.action === 'allow') return { behavior: 'allow' };
          if (verdict.action === 'deny') return { behavior: 'deny', message: verdict.reason };
          return askApproval(CICCIO, state, toolName, input, verdict.reason, opts.signal, opts.toolUseID);
        },
        abortController: state.abort,
        includePartialMessages: true,
        // A fine giro Claude suggerisce il prossimo messaggio (una chiamata in più, sulla cache del giro).
        promptSuggestions: settings().promptSuggestions,
        // Connettori di claude.ai dell'account.
        env: { ...claudeEnv, ENABLE_CLAUDEAI_MCP_SERVERS: 'true' },
      },
    });
    // Contesto dallo stream: getContextUsage dopo il risultato arriva a sessione già chiusa.
    const tracker = contextTracker();
    let noted = false;
    for await (const msg of q) {
      recordUsage(msg);
      tracker.see(msg);
      if (!noted && 'session_id' in msg && msg.session_id) { noted = true; noteTurn(msg.session_id, startedAt, origin); }
      if ('session_id' in msg && typeof msg.session_id === 'string' && msg.session_id && msg.session_id !== store.getKv<string>('ciccio_session')) {
        store.setKv('ciccio_session', msg.session_id);
      }
      if (msg.type === 'result') {
        gotResult = true;
        if (msg.subtype !== 'success' || msg.is_error) failed = msg.subtype;
        const u = tracker.result(msg);
        if (u) {
          const ctx: ContextInfo = { used: u.used, max: u.max, pct: Math.round((u.used / u.max) * 100) };
          store.setKv('ciccio_context', ctx);
          bus.emit({ type: 'ciccioContext', context: ctx });
        }
      }
      handleMessage({ ...CICCIO, path: config.projectsDir }, state, msg);
      // Dopo la compressione il contesto di Ciccio va aggiornato subito, come per le chat (sotto era solo a fine giro).
      if (msg.type === 'system' && msg.subtype === 'compact_boundary' && msg.compact_metadata.post_tokens != null) {
        const prev = ciccioContext();
        if (prev) {
          const ctx: ContextInfo = { used: msg.compact_metadata.post_tokens, max: prev.max, pct: Math.round((msg.compact_metadata.post_tokens / prev.max) * 100) };
          store.setKv('ciccio_context', ctx);
          bus.emit({ type: 'ciccioContext', context: ctx });
        }
      }
      if (msg.type === 'system' && msg.subtype === 'init') { const key = ciccioKey(); void q.supportedCommands().then((l) => saveCommands(key, l)).catch(() => undefined); }
      if (msg.type === 'system' && msg.subtype === 'commands_changed') saveCommands(ciccioKey(), msg.commands);
      if (msg.type === 'result' && !failed) {
        settle();
        early = true;
        if (!state.abort.signal.aborted) setRestartStreak(CICCIO_THREAD, 0);
        const next = isDraining() ? undefined : chatQueue.shift();
        if (next) void chatTurn(next);
      }
    }
  } catch (err) {
    if (!early) failed = err instanceof Error ? err.message : String(err);
  } finally {
    settle();
    dropTail(CICCIO_THREAD, state.abort);
  }
  if (early) return;
  if (failed && !state.abort.signal.aborted) {
    // Sessione vecchia non più riprendibile: si riparte da zero, una volta.
    if (resume && retry && /session|conversation|resume/i.test(failed)) { store.setKv('ciccio_session', null); return chatTurn(original, false, origin); }
    if (!gotResult) {
      const m = store.addMessage(CICCIO, 'error', `Ciccio non è riuscito a rispondere: ${failed}`);
      bus.emit({ type: 'message', message: m });
    }
  }
  const next = isDraining() ? undefined : chatQueue.shift();
  if (next) void chatTurn(next);
}
