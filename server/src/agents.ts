import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { config, claudeEnv, OWNER, withoutClaudeCredentials } from './config.js';
import { agentDisplay } from './display.js';
import { store, type AgentRow, type ChatRow, type Thread } from './db.js';
import { agentEvents, bus, type RoutineTag, type TurnStats } from './bus.js';
import { readStatusMd, statusHeadline, hasOpenWork } from './projects.js';
import { decide, judge, type ToolHints } from './policy.js';
import { ignoreCiccioDir } from './files.js';
import { onSubscription, recordUsage } from './usage.js';
import { noteTurn, turnOrigin, type TurnOrigin } from './consumi.js';
import { settings } from './settings.js';
import { bridgesPrompt, onePasswordAvailable, onePasswordChosen, pcMcpServers, pcPrompt, pcToolHints, releasePcServers } from './companion.js';
import { openChatSshAgent } from './sshAgent.js';
import { openChatSshBridge } from './sshBridge.js';
import { chatDir, createChatWorktree, removeChatWorktree } from './worktrees.js';
import { ORCHESTRATOR_SERVER, TO_CICCIO_TOOL, orchestratorServer } from './orchestrator.js';
import { CREDENTIAL_TOOL, CREDENTIALS_SERVER, credentialProblem, credentialsServer } from './credentials.js';
import { EGRESS_TOOL, INSTALL_TOOL, INSTALL_URL_TOOL, SYSTEM_SERVER, systemServer } from './systemPackages.js';
import { PROPOSALS, PROPOSE_COMMAND, PROPOSE_MCP, ROUTINE_TOOL, TOOLS_SERVER, projectMcpServers, projectToolHints, projectToolsServer } from './projectTools.js';
import { subagentModelHook } from './subagents.js';
import { agentSandbox, confine, confineHook, confineNetwork, memoryDir, noProxyWithSshHosts, prepareProjectDirs, projectEnv, repoSlug, sandboxGitEnv, sessionLockdown, type Scope } from './confine.js';
import { hoistCommand, saveCommands } from './commands.js';
import { ASK_TOOL, CICCIO_THREAD, PERMISSION_LEVELS, questionsOf, SUBAGENT_MODELS, type AgentStatus, type AgentView, type Approval, type Attachment, type ChatView, type Effort, type MessageMeta, type MessageRole, type PermissionLevel, type TodoItem, type ToolMeta, type LiveState } from '../../shared/types.js';

// Come in Claude Code: ogni chat è una sessione a sé (contesto suo, resume suo) che lavora nella
// cartella del progetto. Condividono CLAUDE.md, la memoria del progetto, i file, le regole
// "consenti sempre" e i connettori.

const AGENT_RULES = `Lavori per ${OWNER} su questo progetto tramite Ciccio, la sua sala controllo.

Come parli con ${OWNER}:
- In italiano, dandogli del tu, come un collega bravo che gli scrive in chat: caldo, diretto, naturale. Niente tono da verbale o da log.
- Apri con quello che conta (cosa hai fatto, cosa hai trovato, cosa ti serve), poi i dettagli solo se servono.
- Frasi complete e semplici; elenchi solo quando ci sono davvero più punti. Niente gergo inutile, niente formule di rito.
- Quando una cosa non va, dillo chiaro e proponi la strada per sbloccarla.
- Se ti serve una sua decisione, chiudi con una domanda precisa a cui può rispondere in due parole.

Come scrivi in chat (${OWNER} legge di corsa, spesso dal telefono):
- Messaggi corti. Prima riga: l'esito in una frase.
- Poi, se serve, pochi punti elenco brevi (una riga ciascuno), con il grassetto solo sulla parola chiave.
- Niente tabelle, niente titoli, niente blocchi di codice se non sono codice vero; i nomi di file o comandi tra backtick solo quando servono.
- Se hai domande, mettile in fondo, numerate, ognuna risolvibile con un sì/no o due parole.
- Quando ti serve una scelta di ${OWNER} tra poche alternative, usa AskUserQuestion: gli compare una finestra con le opzioni e risponde con un tocco, anche dal telefono.
- La chat mostra markdown vero: elenchi puntati e numerati, grassetto, link.
- Puoi mostrargli immagini, video e file: salvali nel repo (per i file di lavoro usa .ciccio/out/, che git ignora) e mettili nel messaggio con il percorso relativo alla radice del repo: ![descrizione](.ciccio/out/grafico.png) per un'immagine, [nome](percorso/file.pdf) per un file. Ogni file che citi (anche con un percorso assoluto o ~/, purché non in cartelle nascoste) si apre con un clic nell'anteprima, come nella app di Claude: PDF, pagine HTML vive, Markdown, diagrammi Mermaid, codice, CSV, Excel, Word, notebook, immagini, audio e video. Quando produci un file da far vedere, mettilo sempre nel messaggio come link: non dire di aprirlo a mano. Un link a un .mp4 o .webm diventa un video, uno a un .mp3 un player audio. Le immagini prese dal web si mostrano con il loro indirizzo https.

Regole di lavoro:
- Non fare mai commit o push su main o master: lavora su un branch "ciccio/<descrizione-breve>" e apri una pull request con gh.
- Lavori solo su questo repo. Gli altri progetti di ${OWNER} e i dati di Ciccio non li vedi, e git e gh funzionano solo sul repo del progetto: niente clone di altri repo, niente remote nuovi, niente PR altrove. Se il lavoro tocca un altro progetto, scrivilo a ${OWNER}: ci pensa l'agente di quel progetto.
- I comandi girano in una sandbox: scrivono nel repo e nella cartella temporanea $TMPDIR (non in /tmp). Se un comando fallisce per la sandbox («Read-only file system», «Permission denied» fuori dal repo), cambia strada o chiedi a ${OWNER}. La rete passa da un proxy: per provare un server SSH usa ssh, non nc o /dev/tcp (darebbero sempre «Network is unreachable»).
- A fine giro aggiorna STATUS.md nella radice del repo con le sezioni: "## Fatto", "## Fermo su", "## Serve da ${OWNER}", "## Serve strumento locale", "## Prossimo passo" (punti elenco brevi) e una riga "aggiornato: <data>".`;

/**
 * Contesto occupato dalla sessione, letto dallo stream. Prima lo si chiedeva con getContextUsage dopo il
 * risultato, ma a quel punto la sessione è già chiusa («Query closed before response received») e il
 * dato non arrivava mai. I token dell'ultima chiamata del modello principale (input, cache letta e scritta,
 * output) sono il contesto di adesso; la finestra viene da modelUsage del risultato.
 */
export function contextTracker() {
  let used: number | null = null;
  return {
    see(msg: SDKMessage) {
      // Solo la sessione principale: i sub-agent hanno un contesto tutto loro.
      if (msg.type !== 'assistant' || msg.parent_tool_use_id) return;
      const u = msg.message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      if (!u) return;
      used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    },
    /** A fine giro: contesto usato e finestra del modello, o null se non si sa. */
    result(msg: SDKMessage): { used: number; max: number } | null {
      if (msg.type !== 'result' || used == null) return null;
      const windows = Object.values(msg.modelUsage ?? {}).map((m) => m.contextWindow).filter((n) => n > 0);
      return windows.length ? { used, max: Math.max(...windows) } : null;
    },
  };
}

/** Nome della richiesta di firma con le chiavi SSH di 1Password (non è uno strumento dell'SDK). */
export const SSH_TOOL = 'SSH';
/**
 * Permessi che solo l'utente può dare, mai da Ciccio e mai come regola «consenti sempre» del progetto.
 * Le proposte di strumenti hanno solo «Consenti sempre», che però salva lo strumento, non una regola.
 */
export const ONLY_OWNER = new Set([CREDENTIAL_TOOL, SSH_TOOL, INSTALL_TOOL, INSTALL_URL_TOOL, EGRESS_TOOL, PROPOSE_COMMAND, PROPOSE_MCP, ROUTINE_TOOL]);
/** Firma SSH approvata: fino a quando vale, per chat. */
const sshUntil = new Map<string, number>();
const SSH_WINDOW_MS = 15 * 60_000;

export interface Running {
  abort: AbortController;
  pending: Map<string, (r: PermissionResult) => void>;
  /** Per ogni permesso in attesa, lo strumento che tiene fermo (null: lo chiede lo strumento mentre gira). */
  asking: Map<string, string | null>;
  /** tool_use_id → id del messaggio, per attaccare il risultato allo strumento. */
  tools: Map<string, number>;
  /** Strumenti partiti e non ancora finiti, sub-agent compresi: tool_use_id → strumento che li ha lanciati. */
  inFlight: Map<string, string | null>;
  live: LiveState;
  liveTimer?: ReturnType<typeof setTimeout>;
  /** Chi ha mandato il messaggio del giro (per riprenderlo uguale dopo un riavvio). */
  from?: MessageRole;
  routine?: RoutineTag;
}

/** Stato vuoto di un giro che parte. */
export function newRunning(chatId: string, agentId: string): Running {
  return { abort: new AbortController(), pending: new Map(), asking: new Map(), tools: new Map(), inFlight: new Map(), live: { chatId, agentId, phase: 'thinking', text: '' } };
}

/**
 * Il giro lavora (modello o strumenti) o è fermo sull'utente? Ogni permesso in attesa tiene fermo uno strumento:
 * quello che canUseTool sta per eseguire oppure, se lo chiede lo strumento mentre gira (SSH, programmi di sistema,
 * proposte), lo strumento stesso. Se nessun altro strumento è al lavoro (contano le foglie: un sub-agent con uno
 * strumento fermo è fermo anche lui), il giro non sta facendo niente e un riavvio non perde lavoro.
 */
export function activityOf(state: Running): 'work' | 'wait' {
  if (!state.pending.size) return 'work';
  const parents = new Set([...state.inFlight.values()].filter((p) => p != null));
  const held = new Set(state.asking.values());
  const busy = [...state.inFlight.keys()].filter((id) => !parents.has(id) && !held.has(id)).length;
  const inside = [...state.asking.values()].filter((id) => id == null).length;
  return busy - inside <= 0 ? 'wait' : 'work';
}

/** Stato in diretta: inviato al massimo ogni 80 ms per non intasare la pagina. */
export function emitLive(state: Running, now = false) {
  if (now) { clearTimeout(state.liveTimer); state.liveTimer = undefined; bus.emit({ type: 'live', live: { ...state.live } }); return; }
  if (state.liveTimer) return;
  state.liveTimer = setTimeout(() => { state.liveTimer = undefined; bus.emit({ type: 'live', live: { ...state.live } }); }, 80);
}

/** Sessioni in corso, per id della chat. */
const running = new Map<string, Running>();

/** Sessioni che non sono chat di progetto (Ciccio): contano per i permessi, non per i posti. */
const extraSessions = new Set<string>();
export function trackSession(id: string, state: Running) { running.set(id, state); extraSessions.add(id); }
export function untrackSession(id: string) { running.delete(id); extraSessions.delete(id); }
function busySlots() { return running.size - extraSessions.size; }

/**
 * Processi a giro già finito che aspettano il prompt suggerito (arriva qualche secondo dopo il risultato).
 * Un giro nuovo o un messaggio dell'utente li chiude: il loro suggerimento ormai sarebbe vecchio.
 */
const tails = new Map<string, AbortController>();
export function keepTail(id: string, abort: AbortController) { tails.set(id, abort); }
export function dropTail(id: string, abort?: AbortController) {
  const t = tails.get(id);
  if (!t || (abort && t !== abort)) return;
  tails.delete(id);
  if (!abort) t.abort();
}

/** Prossimo messaggio suggerito a fine giro, per chat (e per Ciccio): si azzera a ogni giro nuovo e a ogni messaggio dell'utente. */
const suggestions = new Map<string, string>();
export function suggestionOf(id: string): string | null { return suggestions.get(id) ?? null; }
export function setSuggestion(id: string, text: string | null) {
  const clean = text?.trim() || null;
  if ((suggestions.get(id) ?? null) === clean) return;
  if (clean) suggestions.set(id, clean);
  else suggestions.delete(id);
  if (id === CICCIO_THREAD) { bus.emit({ type: 'ciccioSuggestion', suggestion: clean }); return; }
  const chat = store.chat(id);
  if (chat) publish(chat.agent_id);
}

/** Server MCP visti all'avvio dell'ultima sessione di ogni progetto. */
const mcpSeen = new Map<string, { name: string; status: string; source?: string }[]>();
export function mcpStatus(agentId: string) { return mcpSeen.get(agentId) ?? []; }

/** Connettori di claude.ai visti nelle ultime sessioni (unione su tutti i progetti, il dato più recente vince). */
export function connectorsSeen(): { name: string; status: string }[] {
  const out = new Map<string, string>();
  for (const list of mcpSeen.values()) for (const m of list) {
    if (m.source && m.source !== 'claudeai' && !/^claude\.ai /.test(m.name)) continue;
    const name = m.name.replace(/^claude\.ai /, '');
    if (!out.has(name) || m.status === 'connected') out.set(name, m.status);
  }
  const list = [...out].map(([name, status]) => ({ name, status })).sort((a, b) => a.name.localeCompare(b.name));
  // Dopo un riavvio del server non ci sono sessioni nuove: vale l'ultimo elenco salvato.
  if (list.length) store.setKv('connectors_seen', list);
  return list.length ? list : store.getKv<{ name: string; status: string }[]>('connectors_seen') ?? [];
}

export interface QueuedTurn { chatId: string; text: string; from: MessageRole; routine?: RoutineTag; origin?: TurnOrigin }
const queue: QueuedTurn[] = [];

/** Spegnimento in corso (restart.ts): nessun giro nuovo parte, i messaggi restano in coda e si salvano. */
let draining = false;
export function beginDrain() { draining = true; }
export function isDraining() { return draining; }

/** Testo accorciato con il segno di quanto manca: nella card si vede che c'è altro (l'input intero si apre a parte). */
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} caratteri]` : s;
}

/** Strumento di Ciccio che consente (o rifiuta) il permesso di un agente al posto dell'utente. */
const CICCIO_ANSWER_TOOL = 'mcp__ciccio__rispondi_permesso';

/** Cosa chiede un permesso, per intero dove conta: il comando esatto, non solo l'inizio del riepilogo. */
function approvalDetail(a: Approval): string {
  const input = a.input as Record<string, unknown> | null;
  if (typeof input?.command === 'string') return `${a.tool}: ${clip(input.command, 4000)}`;
  const at = a.summary.lastIndexOf(' · ');
  return at > 0 ? a.summary.slice(0, at) : a.summary;
}

function summarizeTool(tool: string, input: Record<string, unknown>): string {
  if (tool === CREDENTIAL_TOOL) {
    // Prima il comando, intero (credentialProblem rifiuta quelli troppo lunghi): un motivo lungo non lo nasconde.
    const refs = Array.isArray(input.segreti) ? (input.segreti as { variabile?: string; riferimento?: string }[]).map((s) => `${s.variabile} = ${s.riferimento}`).join(', ') : '';
    return `${tool}: ${String(input.comando ?? '')}\n— segreti: ${refs}\n— motivo: ${String(input.motivo ?? '')}`;
  }
  if (tool === SSH_TOOL) return `${tool}: ${String(input.descrizione ?? '')}`;
  if (tool === INSTALL_TOOL) return `${tool}: installare ${String(input.pacchetto ?? '')} — ${clip(String(input.motivo ?? ''), 600)}`;
  if (tool === INSTALL_URL_TOOL) {
    const cmds = Array.isArray(input.comandi) && input.comandi.length ? `\n— comandi: ${(input.comandi as string[]).join(', ')}` : '';
    const sha = typeof input.sha256 === 'string' && input.sha256 ? `\n— sha256 atteso: ${input.sha256}` : '';
    return `${tool}: installare «${String(input.nome ?? '')}» (${String(input.tipo ?? '')}) da ${clip(String(input.url ?? ''), 520)}${input.sostituisce ? '\n— sostituisce la versione già installata' : ''}${cmds}${sha}\n— motivo: ${clip(String(input.motivo ?? ''), 600)}`;
  }
  if (tool === EGRESS_TOOL) return `${tool}: aprire ${String(input.dominio ?? '')}${input.sottodomini ? ' e tutti i sottodomini' : ''} — ${clip(String(input.motivo ?? ''), 600)}`;
  // Proposte di strumenti e routine: il riepilogo con il comando esatto lo prepara projectTools.ts.
  if (PROPOSALS.has(tool) || tool === ROUTINE_TOOL) return `${tool}: ${clip(String(input.riepilogo ?? ''), 4000)}`;
  // Ciccio che consente al posto dell'utente: nella card c'è cosa consente, a chi, e la regola se è «sempre».
  if (tool === CICCIO_ANSWER_TOOL && input.consenti === true) {
    const target = store.pendingApprovals().find((x) => x.id === input.id);
    if (!target) return `${tool}: consentire il permesso ${String(input.id ?? '')}, che non è più in attesa`;
    const where = `${target.agentId} («${store.chat(target.chatId)?.title ?? ''}»)`;
    const always = input.sempre === true
      ? target.rule ? `\n«Sempre»: salva nel progetto la regola ${target.rule}` : '\n«Sempre» non vale per questo permesso: solo questa volta'
      : '\nSolo questa volta';
    return `${tool}: consentire a ${where} — ${approvalDetail(target)}${always}`;
  }
  const cmd = typeof input.command === 'string' ? input.command : null;
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
  if (cmd) return `${tool}: ${clip(cmd, 2000)}`;
  if (file) return `${tool}: ${file}`;
  return `${tool} ${clip(JSON.stringify(input), 1000)}`;
}

/** Su cosa lavora uno strumento, in forma breve (percorsi relativi al repo). */
function toolTarget(tool: string, input: Record<string, unknown>, repoDir: string): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const file = str('file_path') || str('notebook_path') || str('path');
  if (file) return path.isAbsolute(file) && file.startsWith(repoDir) ? path.relative(repoDir, file) || '.' : file;
  if (tool === 'Bash') return str('command').split('\n')[0].slice(0, 240);
  if (tool === ASK_TOOL) return questionsOf({ tool, input })?.map((q) => q.question).join(' · ').slice(0, 240) ?? 'domanda';
  if (tool === INSTALL_TOOL) return str('pacchetto');
  if (tool === INSTALL_URL_TOOL) return str('nome');
  if (tool === EGRESS_TOOL) return str('dominio');
  if (PROPOSALS.has(tool) || tool === ROUTINE_TOOL) return str('nome');
  return (str('pattern') || str('url') || str('query') || str('description') || JSON.stringify(input)).slice(0, 240);
}

/** Strumenti con un comando: la regola vale per l'inizio del comando, non per lo strumento intero. */
const COMMAND_TOOLS = new Set(['Bash', 'Monitor']);

/**
 * Comando semplice: un comando solo, senza altri attaccati (; & | && || a capo), senza sostituzioni ($( ), backtick,
 * <( )) e con le redirezioni solo dentro il repo (percorsi relativi senza ..) o verso /dev/null e &1/&2.
 * Una regola «consenti sempre» vale solo per questi: «npm test» non fa passare «npm test && curl …».
 */
export function simpleCommand(cmd: string): boolean {
  let rest = cmd;
  for (const m of cmd.matchAll(/(?:\d|&)?(?:>>?|<)(?!\()\s*(&\d|[^\s;&|<>]*)/g)) {
    const target = m[1];
    const inRepo = target !== '' && !/^[/~$]/.test(target) && !/(^|\/)\.\.(\/|$)/.test(target) && !/[`'"]/.test(target);
    if (!(target === '/dev/null' || /^&[12]$/.test(target) || inRepo)) return false;
    rest = rest.replace(m[0], ' ');
  }
  return !/[;&|`<>\n\r]|\$\(/.test(rest);
}

/** Strumento di un connettore o di un server MCP che fa un'azione (non di sola lettura): niente «sempre». */
function mcpAction(tool: string, hints?: ToolHints): boolean {
  return tool.startsWith('mcp__') && judge(tool, {}, '', hints).action !== 'allow';
}

/**
 * Regola "consenti sempre" ricavata da una richiesta, o null se non se ne dà una: per Bash (e Monitor) le prime due
 * parole del comando, valide solo per comandi semplici; per gli altri strumenti il nome, tranne le azioni dei
 * connettori e dei server MCP (ogni invio, creazione o modifica lo approva l'utente). Ciccio non ha regole.
 */
function ruleFor(thread: Thread, tool: string, input: Record<string, unknown>, hints?: ToolHints): string | null {
  if (thread.chatId === CICCIO_THREAD || ONLY_OWNER.has(tool) || PROPOSALS.has(tool) || tool === ASK_TOOL) return null;
  if (COMMAND_TOOLS.has(tool)) {
    const words = typeof input.command === 'string' ? input.command.trim().split(/\s+/).slice(0, 2).join(' ') : '';
    return words ? `${tool}:${words}` : null;
  }
  return mcpAction(tool, hints) ? null : tool;
}

export function matchesRule(rules: string[], tool: string, input: Record<string, unknown>, hints?: ToolHints): boolean {
  if (COMMAND_TOOLS.has(tool)) {
    if (typeof input.command !== 'string') return false;
    const cmd = input.command.trim();
    if (!simpleCommand(cmd)) return false;
    return rules.some((r) => r.startsWith(`${tool}:`) && (cmd === r.slice(tool.length + 1) || cmd.startsWith(`${r.slice(tool.length + 1)} `)));
  }
  // Anche una regola già salvata (o aggiunta a mano) non fa passare le azioni dei connettori.
  if (mcpAction(tool, hints)) return false;
  return rules.includes(tool);
}

export function allowRules(agentId: string): string[] {
  try { return JSON.parse(store.agent(agentId)?.allow_rules ?? '[]') as string[]; } catch { return []; }
}

function firstLine(text: string, max = 140): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const STATUS_RANK: Record<AgentStatus, number> = { wait: 0, block: 1, work: 2, stale: 3, idle: 4 };

function computeChat(chat: ChatRow): ChatView {
  const r = running.get(chat.id);
  const pending = store.pendingApprovals(chat.id);
  const queued = queue.some((q) => q.chatId === chat.id);
  const lastAgent = store.lastMessage(chat.id, 'agent');
  let s: AgentStatus;
  let line: string;
  if (pending.length > 0) { s = 'wait'; line = pending[0].summary; }
  else if (r || queued) { s = 'work'; line = queued && !r ? 'In coda, parte appena si libera un posto' : firstLine(lastAgent?.text ?? 'Al lavoro'); }
  else if (chat.last_error) { s = 'block'; line = firstLine(chat.last_error); }
  else if (chat.last_result && chat.last_result.trim().endsWith('?')) {
    s = 'wait';
    line = firstLine(chat.last_result.trim().split('\n').reverse().find((l) => l.includes('?')) ?? chat.last_result);
  } else { s = 'idle'; line = lastAgent ? firstLine(lastAgent.text) : 'Chat nuova'; }
  return {
    id: chat.id, agentId: chat.agent_id, title: chat.title, status: s, line,
    lastReply: lastAgent?.ts ?? null, lastActivity: chat.last_activity, createdAt: chat.created_at,
    running: !!r, activity: r ? activityOf(r) : 'idle', queued, pendingApprovals: pending.length, permission: chat.permission ?? 'manual',
    model: chat.model || config.agentModel, effort: (chat.effort as Effort | null) || 'high',
    context: chat.context_used != null && chat.context_max ? { used: chat.context_used, max: chat.context_max, pct: Math.round((chat.context_used / chat.context_max) * 100) } : null,
    suggestion: r || queued ? null : suggestionOf(chat.id),
  };
}

function computeView(row: AgentRow): AgentView {
  const chats = store.chats(row.id).map(computeChat);
  const status = readStatusMd(row.path);
  // Lo stato del progetto è quello della chat che chiede più attenzione.
  const urgent = [...chats].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0];
  let s: AgentStatus;
  let line: string;
  if (urgent && urgent.status !== 'idle') {
    s = urgent.status;
    line = chats.length > 1 ? `${urgent.title}: ${urgent.line}` : urgent.line;
  } else {
    const stale = row.last_activity != null && Date.now() - row.last_activity > config.staleDays * 86_400_000;
    const open = status ? hasOpenWork(status) : false;
    s = stale && open ? 'stale' : 'idle';
    line = (status && statusHeadline(status)) ?? (chats[0] && chats[0].lastReply ? chats[0].line : 'Nessun lavoro aperto');
  }
  const replies = chats.map((c) => c.lastReply ?? 0);
  return {
    id: row.id, name: row.display_name?.trim() || row.id,
    lastReply: replies.length && Math.max(...replies) > 0 ? Math.max(...replies) : null,
    status: s, line, lastActivity: row.last_activity,
    running: chats.some((c) => c.running), queued: chats.some((c) => c.queued),
    pendingApprovals: chats.reduce((n, c) => n + c.pendingApprovals, 0),
    hasStatusMd: !!status, chats, connectors: !!row.connectors, pcTools: !!row.pc_tools, hidden: !!row.hidden,
  };
}

export function agentView(id: string): AgentView | null {
  const row = store.agent(id);
  return row ? computeView(row) : null;
}

export function allAgents(): AgentView[] {
  return store.agents().map(computeView);
}

function publish(agentId: string) {
  const v = agentView(agentId);
  if (v) bus.emit({ type: 'agent', agent: v });
}

function say(thread: Thread, role: MessageRole, text: string, meta?: MessageMeta) {
  const message = store.addMessage(thread, role, text, meta);
  bus.emit({ type: 'message', message });
  return message;
}

const threadOf = (chat: ChatRow): Thread => ({ chatId: chat.id, agentId: chat.agent_id });

/** Nuova chat su un progetto: parte con livello, modello ed effort predefiniti nelle Impostazioni. */
export function createChat(agentId: string, title?: string): ChatRow {
  if (!store.agent(agentId)) throw new Error(`Agente sconosciuto: ${agentId}`);
  const d = settings();
  // Le chat oltre la prima lavorano in un worktree loro: due chat insieme non si cambiano branch e file a vicenda.
  const others = store.chats(agentId).length;
  const chat = store.createChat({
    agent_id: agentId, title: title?.trim().slice(0, 80) || 'Nuova chat', auto_title: title?.trim() ? 0 : 1,
    permission: d.defaultPermission, model: d.defaultModel, effort: d.defaultEffort,
  });
  if (others > 0) {
    const wt = createChatWorktree(store.agent(agentId)!.path, chat.id);
    if (wt) store.updateChat(chat.id, { worktree: wt.dir });
  }
  publish(agentId);
  return store.chat(chat.id) ?? chat;
}

/** Chat più recente del progetto, o una nuova se non ce n'è nessuna. */
export function latestChat(agentId: string): ChatRow {
  return store.chats(agentId)[0] ?? createChat(agentId);
}

/** Titolo come in Claude Code: subito il primo messaggio accorciato, poi uno breve scritto da Claude. */
function autoTitle(chat: ChatRow, text: string) {
  if (!chat.auto_title || store.countMessages(chat.id, 'user') + store.countMessages(chat.id, 'ciccio') > 1) return;
  const quick = firstLine(text, 48);
  store.updateChat(chat.id, { title: quick });
  publish(chat.agent_id);
  void (async () => {
    try {
      let out = '';
      const q = query({
        prompt: `Dai un titolo di 2-5 parole, in italiano, a una chat di lavoro che inizia con questo messaggio. Solo il titolo, senza virgolette né punto finale.\n\n"""${text.slice(0, 1500)}"""`,
        options: { cwd: config.dataDir, model: 'claude-haiku-5-5', maxTurns: 1, settingSources: [], tools: [], permissionMode: 'dontAsk', env: { ...claudeEnv, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } },
      });
      for await (const m of q) { recordUsage(m); if (m.type === 'result' && m.subtype === 'success') out = m.result; }
      const title = out.trim().replace(/^["'«]|["'»]$/g, '').split('\n')[0].slice(0, 60);
      // Se nel frattempo l'utente l'ha rinominata, vince il suo nome.
      if (title && store.chat(chat.id)?.auto_title) { store.updateChat(chat.id, { title }); publish(chat.agent_id); }
    } catch { /* resta il titolo provvisorio */ }
  })();
}

/** Chat al lavoro, in coda o in attesa di una risposta dell'utente. */
export function chatBusy(chatId: string): boolean {
  return running.has(chatId) || queue.some((q) => q.chatId === chatId) || store.pendingApprovals(chatId).length > 0;
}

/**
 * Manda un messaggio a una chat: parte subito o resta in coda. `routine`: lo manda una routine a nome
 * dell'utente (si vede nella chat e torna nell'evento di fine giro, con il consumo).
 */
export function sendToChat(chatId: string, userText: string, from: MessageRole = 'user', attachments: Attachment[] = [], routine?: RoutineTag): 'started' | 'queued' {
  const chat = store.chat(chatId);
  if (!chat) throw new Error(`Chat sconosciuta: ${chatId}`);
  if (chat.archived) store.updateChat(chatId, { archived: 0 });
  dropTail(chatId);
  setSuggestion(chatId, null);
  say(threadOf(chat), from, userText, attachments.length || routine ? { kind: 'user', attachments, ...(routine ? { routine: routine.name } : {}) } : undefined);
  // Scritto da lui, non da Ciccio: gli avvisi di Ciccio su questa chat (domande, permessi) sono vecchi da adesso.
  if (from === 'user') agentEvents.userWrote(chatId);
  autoTitle(chat, userText);
  // Gli allegati sono file nel repo: l'agente li legge con Read (testo, codice, immagini, PDF).
  // Le chat con un worktree lavorano altrove: gli allegati (caricati nel repo) si danno con il percorso completo.
  const repo = chat.worktree ? store.agent(chat.agent_id)?.path : null;
  const text = staleNote(chatId) + (attachments.length
    ? `${userText}\n\nAllegati di ${OWNER} (${repo ? 'percorsi completi' : 'percorsi nel repo'}):\n${attachments.map((a) => `- ${repo ? path.join(repo, a.path) : a.path}`).join('\n')}`
    : userText);
  if (draining || running.has(chatId) || busySlots() >= settings().maxActive) {
    queue.push({ chatId, text, from, routine });
    publish(chat.agent_id);
    return 'queued';
  }
  void run(chatId, text, from, routine);
  return 'started';
}

/** Messaggio a un progetto senza chat precisa (Ciccio): va alla chat più recente o a una nuova. */
export function sendToAgent(agentId: string, text: string, from: MessageRole = 'user', opts: { newChat?: boolean; chatId?: string; attachments?: Attachment[] } = {}) {
  const chat = opts.chatId ? store.chat(opts.chatId) : opts.newChat ? createChat(agentId) : latestChat(agentId);
  if (!chat || chat.agent_id !== agentId) throw new Error('Chat non trovata in questo progetto');
  return { chatId: chat.id, title: store.chat(chat.id)!.title, result: sendToChat(chat.id, text, from, opts.attachments ?? []) };
}

/**
 * Un giro che non è un messaggio dell'utente: la ripresa dopo un riavvio, o un messaggio rimasto in coda prima.
 * Niente messaggio nella chat (c'è già, o lo spiega la nota di sistema): solo il giro, subito o in coda.
 */
export function continueChat(chatId: string, text: string, from: MessageRole = 'user', routine?: RoutineTag, origin?: TurnOrigin): 'started' | 'queued' | 'missing' {
  const chat = store.chat(chatId);
  if (!chat) return 'missing';
  const full = staleNote(chatId) + text;
  if (draining || running.has(chatId) || busySlots() >= settings().maxActive) {
    queue.push({ chatId, text: full, from, routine, origin });
    publish(chat.agent_id);
    return 'queued';
  }
  void run(chatId, full, from, routine, origin);
  return 'started';
}

/** Giro in corso in una chat, per il registro dello spegnimento: attività, permessi in attesa, strumenti a metà. */
export interface TurnSnapshot {
  chatId: string; agentId: string; activity: 'work' | 'wait'; from: MessageRole; routine?: RoutineTag; approvals: Approval[]; tools: string[];
  /** Risposte già date dall'utente a card riproposte dopo un riavvio precedente. */
  answers?: string[];
}

export function turnSnapshot(chatId: string, state: Running): TurnSnapshot {
  const open = new Set(state.tools.values());
  const tools = store.messages(chatId, 80).filter((m) => open.has(m.id) && m.meta?.kind === 'tool' && !m.meta.done).map((m) => m.text.slice(0, 300));
  return { chatId, agentId: state.live.agentId, activity: activityOf(state), from: state.from ?? 'user', routine: state.routine, approvals: store.pendingApprovals(chatId), tools };
}

/** Giri in corso nelle chat dei progetti (Ciccio a parte). */
export function runningTurns(): TurnSnapshot[] {
  return [...running].filter(([id]) => !extraSessions.has(id)).map(([chatId, state]) => turnSnapshot(chatId, state));
}

export function queuedTurns(): QueuedTurn[] { return queue.map((q) => ({ ...q })); }

/** Allo spegnimento: ferma tutti i giri (Ciccio compreso) senza note in chat, il registro è già salvato. */
export function abortAll() {
  for (const state of running.values()) state.abort.abort();
  for (const t of tails.values()) t.abort();
}

/** Riprese automatiche di fila dopo un riavvio, per chat (e per Ciccio): si azzera a ogni giro finito bene. */
export function restartStreak(id: string): number { return store.getKv<Record<string, number>>('restart_streak')?.[id] ?? 0; }
export function setRestartStreak(id: string, n: number) {
  const all = store.getKv<Record<string, number>>('restart_streak') ?? {};
  if ((all[id] ?? 0) === n) return;
  if (n) all[id] = n; else delete all[id];
  store.setKv('restart_streak', all);
}

// ── Richieste riproposte dopo un riavvio ───────────────────────────────────
// Un giro fermo su un permesso o una domanda non tiene fermo il riavvio: la richiesta si salva e torna nella
// chat come card, senza una sessione che la aspetti. Quando l'utente ha risposto a tutte quelle della chat, il
// giro riprende con le sue risposte; un permesso consentito vale una volta, per lo stesso passo rifatto.

interface Parked { turn: TurnSnapshot; thread: Thread; open: Map<string, Approval>; answers: string[]; resume: (answers: string[]) => void }
const parked = new Map<string, Parked>();
/** Permessi consentiti su card riproposte, per chat: il passo rifatto uguale passa senza chiedere (una volta). */
const preapproved = new Map<string, { key: string; result: PermissionResult }[]>();

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}

/** Stesso strumento con lo stesso input (la descrizione di Bash è solo un'etichetta e può cambiare). */
function approvalKey(tool: string, input: Record<string, unknown>): string {
  const { description: _label, ...rest } = input;
  return `${tool}\n${JSON.stringify(stable(rest))}`;
}

function takePreapproved(chatId: string, tool: string, input: Record<string, unknown>): PermissionResult | null {
  const list = preapproved.get(chatId);
  const key = approvalKey(tool, input);
  const i = list ? list.findIndex((p) => p.key === key) : -1;
  if (!list || i < 0) return null;
  const [p] = list.splice(i, 1);
  if (!list.length) preapproved.delete(chatId);
  return p.result;
}

export function clearPreapproved(chatId: string) { preapproved.delete(chatId); }

/** Ripropone le richieste di un giro interrotto mentre aspettava l'utente; `resume` riparte con le sue risposte. */
export function parkApprovals(turn: TurnSnapshot, resume: (answers: string[]) => void) {
  if (!turn.approvals.length) return;
  for (const a of turn.approvals) store.setApproval(a.id, 'pending');
  const thread = { chatId: turn.chatId, agentId: turn.agentId };
  parked.set(turn.chatId, { turn, thread, open: new Map(turn.approvals.map((a) => [a.id, a])), answers: [...(turn.answers ?? [])], resume });
  if (turn.chatId !== CICCIO_THREAD) publish(turn.agentId);
}

/** Richieste riproposte ancora aperte, con le risposte già date: un altro riavvio adesso le ripropone uguali. */
export function parkedTurns(): TurnSnapshot[] {
  return [...parked.values()].map((p) => ({ ...p.turn, approvals: [...p.open.values()], answers: [...p.answers] }));
}

function findParked(id: string): [Parked, Approval] | null {
  for (const p of parked.values()) {
    const a = p.open.get(id);
    if (a) return [p, a];
  }
  return null;
}

function closeParked(p: Parked, approval: Approval, status: 'allowed' | 'denied', answer: string) {
  store.setApproval(approval.id, status);
  bus.emit({ type: 'approval', approval: { ...approval, status } });
  p.open.delete(approval.id);
  p.answers.push(answer);
  if (!p.open.size) { parked.delete(p.thread.chatId); p.resume(p.answers); }
  if (p.thread.chatId !== CICCIO_THREAD) publish(p.thread.agentId);
}

/**
 * L'utente scrive (o ferma la chat) con richieste riproposte ancora aperte: scadono, e il messaggio dice
 * all'agente cosa aspettava e cosa l'utente aveva già deciso, così rifà il passo se gli serve ancora.
 */
export function staleNote(chatId: string): string {
  const p = parked.get(chatId);
  if (!p) return '';
  parked.delete(chatId);
  for (const a of p.open.values()) {
    store.setApproval(a.id, 'denied');
    bus.emit({ type: 'approval', approval: { ...a, status: 'denied' } });
  }
  const lines = [...[...p.open.values()].map((a) => `- ancora in attesa: ${a.summary.split('\n')[0]}`), ...p.answers.map((x) => `- ${x}`)];
  return `[Ciccio è stato riavviato mentre aspettavi ${OWNER} e il giro di prima si è interrotto lì. Le richieste ancora aperte sono scadute: se ti servono, rifai il passo e gli ricompaiono.\n${lines.join('\n')}]\n\n`;
}

function nextFromQueue() {
  if (draining) return;
  while (busySlots() < settings().maxActive) {
    const idx = queue.findIndex((q) => !running.has(q.chatId));
    if (idx < 0) return;
    const [item] = queue.splice(idx, 1);
    void run(item.chatId, item.text, item.from, item.routine, item.origin);
  }
}

/** Mette una richiesta in attesa dell'utente (salvata, sulla pagina) e aspetta la risposta; fermando il giro si chiude. */
function waitForOwner(thread: Thread, state: Running, tool: string, summary: string, input: Record<string, unknown>, signal: AbortSignal, toolUseId?: string): Promise<PermissionResult> {
  // Già consentito dall'utente su una card riproposta dopo un riavvio: lo stesso passo rifatto passa.
  const pre = takePreapproved(thread.chatId, tool, input);
  if (pre) {
    say(thread, 'tool', `✓ già approvato · ${summary.split('\n')[0]}`);
    return Promise.resolve(pre);
  }
  // La regola che «Consenti sempre» salverebbe: decisa qui e mostrata nella card, così l'utente vede cosa consente.
  const rule = ruleFor(thread, tool, input, projectToolHints(thread.agentId, tool) ?? pcToolHints(tool));
  const approval: Approval = { id: randomUUID(), chatId: thread.chatId, agentId: thread.agentId, tool, summary, input, ts: Date.now(), status: 'pending', rule };
  store.addApproval(approval);
  bus.emit({ type: 'approval', approval });
  publish(thread.agentId);
  return new Promise<PermissionResult>((resolve) => {
    state.asking.set(approval.id, toolUseId ?? null);
    lingering.set(approval.id, state);
    state.pending.set(approval.id, (r) => { state.asking.delete(approval.id); lingering.delete(approval.id); resolve(r); });
    signal.addEventListener('abort', () => {
      state.asking.delete(approval.id);
      lingering.delete(approval.id);
      if (state.pending.delete(approval.id)) {
        store.setApproval(approval.id, 'denied');
        // La card (o la finestra della domanda) sparisce anche dalle pagine aperte.
        bus.emit({ type: 'approval', approval: { ...approval, status: 'denied' } });
        resolve({ behavior: 'deny', message: 'Sessione interrotta.' });
      }
    });
  });
}

/**
 * Richieste in attesa per id, anche quando il giro è già finito e non sta più in `running`: l'agente SSH e i processi
 * lasciati in coda possono chiedere le chiavi dopo la fine del giro, e la risposta deve comunque arrivargli.
 */
const lingering = new Map<string, Running>();

/** Chi aspetta questa richiesta: un giro in corso, oppure uno finito che ha ancora un processo in coda. */
function waiting(id: string): [string, Running] | null {
  for (const [chatId, state] of running) if (state.pending.has(id)) return [chatId, state];
  const state = lingering.get(id);
  return state ? [state.live.chatId, state] : null;
}

/** Permesso rimasto «in attesa» nel database senza nessuno che lo aspetti: si chiude, così la card non resta lì morta. */
function closeOrphan(id: string) {
  const a = store.pendingApprovals().find((x) => x.id === id);
  if (!a || findParked(id)) return;
  store.setApproval(id, 'denied');
  bus.emit({ type: 'approval', approval: { ...a, status: 'denied' } });
  if (a.chatId !== CICCIO_THREAD) publish(a.agentId);
}

/** Chiede un permesso all'utente nella chat della sessione e aspetta la risposta. */
export function askApproval(thread: Thread, state: Running, toolName: string, input: Record<string, unknown>, reason: string, signal: AbortSignal, toolUseId?: string): Promise<PermissionResult> {
  return waitForOwner(thread, state, toolName, `${summarizeTool(toolName, input)} · ${reason}`, input, signal, toolUseId);
}

/**
 * Domanda a scelte (AskUserQuestion): come un permesso, ma la risposta dell'utente torna a Claude
 * nell'input dello strumento (answers). Non è un'azione: va sempre all'utente, in ogni livello.
 */
export function askQuestion(thread: Thread, state: Running, input: Record<string, unknown>, signal: AbortSignal, toolUseId?: string): Promise<PermissionResult> {
  const qs = questionsOf({ tool: ASK_TOOL, input });
  if (!qs) return Promise.resolve({ behavior: 'deny', message: 'Domanda non valida: servono da 1 a 4 domande, ognuna con le sue opzioni.' });
  // Riga breve per lo stato della chat e gli avvisi: la prima domanda, più quante altre.
  const summary = `Domanda: ${qs[0].question}${qs.length > 1 ? ` (+${qs.length - 1})` : ''}`.slice(0, 400);
  return waitForOwner(thread, state, ASK_TOOL, summary, input, signal, toolUseId);
}

/**
 * Risposta dell'utente a una domanda: per ogni domanda (chiave: il suo testo) le scelte separate da virgola
 * o il testo libero. Le domande saltate restano fuori; tutte saltate = Claude va avanti da solo.
 */
function cleanAnswers(approval: Approval, answers: Record<string, string>): Record<string, string> {
  const asked = new Set((questionsOf(approval) ?? []).map((q) => q.question));
  return Object.fromEntries(Object.entries(answers)
    .filter(([q, a]) => asked.has(q) && typeof a === 'string' && a.trim())
    .map(([q, a]) => [q, a.trim().slice(0, 2000)]));
}

export function answerQuestion(id: string, answers: Record<string, string>): boolean {
  const held = waiting(id);
  if (held) {
    const [chatId, state] = held;
    const resolve = state.pending.get(id)!;
    const approval = store.pendingApprovals(chatId).find((a) => a.id === id);
    if (!approval || approval.tool !== ASK_TOOL) return false;
    const clean = cleanAnswers(approval, answers);
    const given = Object.values(clean);
    const thread: Thread = { chatId, agentId: approval.agentId };
    state.pending.delete(id);
    store.setApproval(id, given.length ? 'allowed' : 'denied');
    bus.emit({ type: 'approval', approval: { ...approval, status: given.length ? 'allowed' : 'denied' } });
    resolve(given.length
      ? { behavior: 'allow', updatedInput: { ...(approval.input as Record<string, unknown>), answers: clean } }
      : { behavior: 'deny', message: `${OWNER} ha saltato le domande: vai avanti con il tuo giudizio, o chiediglielo in chat se proprio serve.` });
    say(thread, 'tool', given.length ? `✓ risposto · ${given.join(' · ').slice(0, 200)}` : '↷ domande saltate');
    publish(thread.agentId);
    return true;
  }
  // Domanda riproposta dopo un riavvio: le risposte vanno nel messaggio con cui il giro riprende.
  const found = findParked(id);
  if (!found || found[1].tool !== ASK_TOOL) return false;
  const [p, approval] = found;
  const given = Object.entries(cleanAnswers(approval, answers));
  say(p.thread, 'tool', given.length ? `✓ risposto · ${given.map(([, a]) => a).join(' · ').slice(0, 200)}` : '↷ domande saltate');
  closeParked(p, approval, given.length ? 'allowed' : 'denied', given.length
    ? `${OWNER} ha risposto alle tue domande: ${given.map(([q, a]) => `«${q}» → ${a}`).join('; ')}`
    : `${OWNER} ha saltato le domande (${approval.summary}): vai avanti con il tuo giudizio, o chiediglielo in chat se proprio serve.`);
  return true;
}

async function run(chatId: string, prompt: string, from: MessageRole = 'user', routine?: RoutineTag, origin = turnOrigin(from, routine)) {
  const chat = store.chat(chatId);
  const row = chat ? store.agent(chat.agent_id) : undefined;
  if (!chat || !row) return;
  const thread = threadOf(chat);
  // Cartella della chat: il suo worktree (chat oltre la prima) o il repo.
  const dir = chatDir(chat, row);
  ignoreCiccioDir(dir);
  const state: Running = { ...newRunning(chatId, row.id), from, routine };
  const startedAt = Date.now();
  dropTail(chatId);
  suggestions.delete(chatId);
  running.set(chatId, state);
  store.updateChat(chatId, { last_error: null, last_result: null, last_activity: Date.now(), turn_started: Date.now() });
  store.updateAgent(row.id, { last_activity: Date.now() });
  publish(row.id);
  emitLive(state, true);

  // Repo GitHub del progetto: git e gh lavorano solo su questo. Si scrive solo nella cartella della chat.
  const scope: Scope = { project: row.id, repo: row.path, dir, slug: repoSlug(row.path) };
  // Memoria, cache dei pacchetti e known_hosts del progetto, solo suoi (confine.ts).
  prepareProjectDirs(row.id, row.path, store.agents().map((a) => a.path));
  const canUseTool = async (toolName: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID?: string }): Promise<PermissionResult> => {
    // Domande a scelte: sempre all'utente, in ogni livello (anche «Ignora autorizzazioni»).
    if (toolName === ASK_TOOL) return askQuestion(thread, state, input, opts.signal, opts.toolUseID);
    // Segreti di 1Password: chiede sempre all'utente, in ogni livello e senza regole.
    // Comando o motivo che non starebbero interi nella card: rifiutati prima di chiedere.
    if (toolName === CREDENTIAL_TOOL) {
      const problem = credentialProblem(input);
      return problem ? { behavior: 'deny', message: problem } : askApproval(thread, state, toolName, input, 'segreto da 1Password, lo approvi solo tu', opts.signal, opts.toolUseID);
    }
    // Messaggio a Ciccio: sempre consentito (non tocca niente fuori, lo legge solo l'orchestratore).
    if (toolName === TO_CICCIO_TOOL) return { behavior: 'allow' };
    // Programmi di sistema: la card la apre lo strumento stesso, sempre, dopo aver controllato il pacchetto (systemPackages.ts).
    if (toolName === INSTALL_TOOL || toolName === INSTALL_URL_TOOL || toolName === EGRESS_TOOL) return { behavior: 'allow' };
    // Proposte di strumenti e routine: anche qui la card la apre lo strumento, dopo i suoi controlli (projectTools.ts).
    if (PROPOSALS.has(toolName) || toolName === ROUTINE_TOOL) return { behavior: 'allow' };
    // Solo il proprio repo, in ogni livello (anche "Salta permessi"): altri progetti, altri repo e indirizzi interni no.
    // Lo stesso controllo gira prima nell'hook PreToolUse (confineHook), che vale anche contro le regole dei file.
    const confined = confine(toolName, input, scope) ?? await confineNetwork(toolName, input);
    if (confined?.action === 'deny') {
      say(thread, 'tool', `✗ bloccato · ${summarizeTool(toolName, input)} (${confined.reason})`);
      return { behavior: 'deny', message: confined.reason };
    }
    // Host nuovo da un comando nella sandbox: i domini li filtra già il firewall in uscita, quelli interni li nega confineNetwork.
    if (toolName === 'SandboxNetworkAccess') return { behavior: 'allow' };
    // Il livello si rilegge a ogni richiesta: cambiarlo dalla chat vale subito, anche a sessione avviata.
    const level = store.chat(chatId)?.permission ?? 'manual';
    const hints = projectToolHints(row.id, toolName) ?? pcToolHints(toolName);
    const verdict = decide(level, toolName, input, row.path, hints);
    if (verdict.action === 'allow') return { behavior: 'allow' };
    if (verdict.action === 'ask' && matchesRule(allowRules(row.id), toolName, input, hints)) return { behavior: 'allow' };
    if (verdict.action === 'deny') {
      say(thread, 'tool', `✗ bloccato · ${summarizeTool(toolName, input)} (${verdict.reason})`);
      return { behavior: 'deny', message: verdict.reason };
    }
    return askApproval(thread, state, toolName, input, verdict.reason, opts.signal, opts.toolUseID);
  };

  // Gli errori arrivati come risultato li mostra già handleMessage: nel catch solo quelli senza risultato.
  let gotResult = false;
  // Consumo del giro, dal risultato: va nell'evento di fine (le routine lo registrano).
  let stats: TurnStats | undefined;
  // Strumenti dei PC accesi adesso (companion), se l'utente non li ha spenti per il progetto.
  // Con il repo del progetto: scarica_da_ciccio e carica_su_ciccio scambiano file solo con quello.
  const pcServers = row.pc_tools ? pcMcpServers({ repoDir: dir, who: `${row.id} / ${chat.title}` }) : {};
  // Chiavi SSH di 1Password: socket della chat; ogni firma la approva l'utente (vale 15 minuti), poi Touch ID sul Mac.
  let sshAsking: Promise<boolean> | null = null;
  const approveSsh = (): Promise<boolean> => {
    if ((sshUntil.get(chatId) ?? 0) > Date.now()) return Promise.resolve(true);
    sshAsking ??= askApproval(thread, state, SSH_TOOL, { descrizione: 'usare le tue chiavi SSH di 1Password per 15 minuti in questa chat' }, 'chiavi SSH, lo approvi solo tu', state.abort.signal)
      .then((r) => { if (r.behavior === 'allow') sshUntil.set(chatId, Date.now() + SSH_WINDOW_MS); return r.behavior === 'allow'; })
      .finally(() => { sshAsking = null; });
    return sshAsking;
  };
  const ssh = openChatSshAgent(chatId, approveSsh, (t) => say(thread, 'tool', t), state.abort.signal);
  // Ponti SSH: i server della rete di un PC (es. l'ufficio) attraverso il companion, se il PC li consente.
  const bridge = openChatSshBridge(chatId, (t) => say(thread, 'tool', t), state.abort.signal);
  // Server SSH dell'elenco di Ciccio senza tinyproxy: dalla sandbox ssh passa dal suo proxy e poi va diretto.
  const noProxy = noProxyWithSshHosts(claudeEnv.NO_PROXY ?? claudeEnv.no_proxy);
  // Connettori di claude.ai: accesi per il progetto e solo con il login dell'abbonamento.
  const connectors = !!row.connectors && onSubscription();
  // Cache dei pacchetti e known_hosts del progetto (projectEnv): i comandi della sandbox scrivono solo lì.
  // sandboxGitEnv: git nella sandbox ignora i punti di montaggio di bubblewrap (.bashrc, .vscode…).
  const agentEnv = { ...claudeEnv, ...agentDisplay(), ...projectEnv(row.id), ...sandboxGitEnv(row.id), ENABLE_CLAUDEAI_MCP_SERVERS: connectors ? 'true' : 'false', SSH_AUTH_SOCK: ssh.path, CICCIO_SSH_BRIDGE: bridge.path, NO_PROXY: noProxy, no_proxy: noProxy };
  const credServer = credentialsServer(scope, state.abort.signal);
  const orchServer = orchestratorServer({ agentId: row.id, chatId, chatTitle: chat.title });
  const sysServer = systemServer({
    ask: (tool, input, reason) => askApproval(thread, state, tool, input, reason, state.abort.signal).then((r) => r.behavior === 'allow'),
    note: (t) => say(thread, 'tool', t),
    who: `${row.id} / ${chat.title}`,
  }, state.abort.signal);
  // Strumenti su misura del progetto: proposte, routine e quelli già approvati dall'utente (differiti dietro ToolSearch).
  const toolsServer = projectToolsServer({
    ask: (name, input, reason) => askApproval(thread, state, name, input, reason, state.abort.signal)
      .then((r) => ({ allowed: r.behavior === 'allow', always: r.behavior === 'allow' && (r.updatedInput as { sempre?: unknown } | undefined)?.sempre === true })),
    note: (t) => say(thread, 'tool', t),
    agentId: row.id, repo: dir, chatTitle: chat.title, chatId,
  });
  // Le istruzioni restano identiche da un giro all'altro: ogni sessione riparte in un processo nuovo e
  // un solo carattere diverso all'inizio della richiesta fa ripagare tutta la conversazione (cache persa).
  // Quello che cambia (PC accesi, chiavi SSH) va nel messaggio, che sta in fondo e non tocca la cache.
  const rules = [AGENT_RULES];
  // Modelli dei sub-agent scelti dall'utente nelle Impostazioni: l'hook sotto li impone comunque.
  const subModels = settings().subagentModels;
  const named = (ids: string[]) => SUBAGENT_MODELS.filter((m) => ids.includes(m.id)).map((m) => `${m.id} (${m.hint})`).join(', ');
  rules.push(`- Per lavori grandi o separabili usa i sub-agent (strumento Agent), anche in parallelo, indicando sempre il modello (campo model). ${OWNER} consente solo: ${named(subModels)}. Un altro modello viene sostituito da solo con il più vicino tra questi.`);
  if (dir !== row.path) rules.push(`- Questa chat lavora in un worktree suo (${dir}, branch ${chat.worktree ? `ciccio/chat-${chat.id}` : ''}): la cartella principale del progetto è di un'altra chat. Committa e apri le PR da qui; per il lavoro di questa chat non toccare la cartella principale.`);
  rules.push(`- Le chat non si parlano tra loro: se ti serve qualcosa da un altro progetto o un coordinamento, scrivilo a Ciccio, l'orchestratore, con scrivi_a_ciccio. Ciccio può anche scriverti lui, in nome di ${OWNER}: trattalo come una richiesta di ${OWNER}.`);
  if (connectors) rules.push(`- Hai i connettori di ${OWNER} (posta, calendario, Notion e altri) come strumenti mcp__: usali quando servono al lavoro.`);
  rules.push(`- PC di ${OWNER} e chiavi SSH vanno e vengono: la riga «[Adesso: …]» all\'inizio di un messaggio dice cosa c\'è in quel momento e vale più di quello che sapevi prima.`);
  rules.push(`- SSH: ssh, scp, rsync e git usano le chiavi SSH di ${OWNER} in 1Password, che arrivano dal suo Mac o PC Windows solo quando è acceso con il companion. La prima firma la approva ${OWNER} in Ciccio e vale 15 minuti; poi conferma sul PC (una finestra con utente e server, poi Touch ID o Windows Hello). Il PC firma solo accessi SSH: firme di commit o di altri dati con queste chiavi non passano. Se la firma fallisce («agent refused operation», «signing failed»), ${OWNER} non ha ancora approvato: diglielo in chat e rilancia il comando dopo il suo ok, non insistere in background. Raggiungi solo i server nell'elenco SSH di Ciccio: se un host non risponde, chiedi a ${OWNER} di aggiungerlo. Non creare né copiare chiavi private.`);
  rules.push(`- Server SSH interni (192.168.x.x, 10.x.x.x, nomi della rete dell'ufficio): li raggiungi solo se ${OWNER} ha impostato un ponte attraverso un suo PC in Configurazione › Server SSH; ssh lo usa da solo. Se non c'è, chiedilo a ${OWNER}, non cercare altre strade.`);
  rules.push(`- Se ti manca un programma di sistema (es. openscad, imagemagick), chiedilo con lo strumento installa_programma: solo pacchetti ufficiali di Ubuntu, lo approva ${OWNER} ogni volta. Se il programma non è nei repository di Ubuntu (es. FreeCAD, che esce come AppImage), usa installa_da_url con l'indirizzo https diretto della AppImage o dell'archivio ufficiale: ${OWNER} vede indirizzo, nome e comandi e approva ogni volta. Non provare sudo o apt. Una volta installato, i comandi che lo usano seguono il livello di autorizzazione della chat come gli altri. Se il proxy blocca un sito che ti serve (403 o 502 dal proxy, «Proxying refused»), chiedi quel dominio con consenti_dominio.`);
  rules.push(`- Se ti serve uno strumento che non hai e che userai più volte (un programma o uno script del server con parametri fissi, o un server MCP), proponilo con proponi_comando o proponi_server_mcp (server ciccio_strumenti, li trovi con ToolSearch): ${OWNER} vede il comando esatto e, se lo consente, resta al progetto per tutte le chat. Per un lavoro da ripetere a orari fissi proponi una routine con crea_routine.`);
  rules.push(`- Password, chiavi API e altri segreti: non chiederli mai a ${OWNER} in chat e non scriverli nei file. Usa lo strumento usa_credenziale con il riferimento di 1Password (op://vault/elemento/campo); se non lo conosci, chiedi a ${OWNER} il riferimento, non il valore.`);
  const sshPc = onePasswordAvailable('sshAgent');
  const now = [
    `- Ora: ${new Intl.DateTimeFormat('it-IT', { timeZone: config.tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date())} (fuso ${config.tz}).`,
    // Le routine partono da sole: l'utente può non essere davanti allo schermo per rispondere.
    routine ? `- Questo messaggio l'ha mandato in automatico la routine «${routine.name}»: ${OWNER} potrebbe non vederlo subito, quindi chiudi il lavoro da solo e lascia domande e risultati nella risposta.` : '',
    row.pc_tools ? pcPrompt(pcServers) || `- Nessun PC di ${OWNER} acceso con il companion: niente strumenti del PC.` : '',
    sshPc ? `- Chiavi SSH di 1Password disponibili (PC "${sshPc}").`
      : onePasswordChosen() ? `- Chiavi SSH di 1Password non disponibili: ${OWNER} le ha impostate sul PC "${onePasswordChosen()}", che adesso è spento o ha il companion chiuso. Se ti serve SSH, diglielo.`
      : `- Chiavi SSH di 1Password non disponibili (nessun PC acceso con il companion): se ti serve SSH, dillo a ${OWNER}.`,
    bridgesPrompt(),
  ].filter(Boolean);
  // I comandi (/compact) vanno così come sono, anche se scritti a metà messaggio (portati in testa).
  const sent = hoistCommand(row.id, prompt);
  const turnPrompt = sent.startsWith('/') ? sent : `[Adesso:\n${now.join('\n')}]\n\n${sent}`;
  // Il giro finisce al risultato, non quando il processo si chiude: dopo il risultato l'SDK resta aperto
  // qualche secondo per scrivere il prompt suggerito, e intanto la chat è già libera.
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    releasePcServers(pcServers);
    ssh.close();
    bridge.close();
    void credServer.instance.close().catch(() => undefined);
    void sysServer.instance.close().catch(() => undefined);
    void toolsServer.instance.close().catch(() => undefined);
    void orchServer.instance.close().catch(() => undefined);
    state.live = { chatId, agentId: row.id, phase: 'idle', text: '' };
    emitLive(state, true);
    running.delete(chatId);
    keepTail(chatId, state.abort);
    clearPreapproved(chatId);
    // Giro finito davvero (non fermato, né dallo spegnimento): le riprese dopo un riavvio ripartono da zero.
    if (gotResult && !state.abort.signal.aborted) setRestartStreak(chatId, 0);
    store.updateChat(chatId, { last_activity: Date.now(), turn_started: null });
    store.updateAgent(row.id, { last_activity: Date.now() });
    publish(row.id);
    agentEvents.finished({ chatId, agentId: row.id, aborted: state.abort.signal.aborted, error: store.chat(chatId)?.last_error ?? null, from: from === 'ciccio' ? 'ciccio' : 'user', routine, stats });
    nextFromQueue();
  };
  try {
    const q = query({
      prompt: turnPrompt,
      options: {
        cwd: dir,
        resume: chat.session_id ?? undefined,
        model: chat.model || config.agentModel,
        effort: (chat.effort as Effort | null) || 'high',
        permissionMode: 'default',
        canUseTool,
        // Comandi Bash chiusi nel repo del progetto (bubblewrap): vedi confine.ts.
        // Le credenziali di Anthropic restano al processo di Claude Code: i comandi non le vedono (config.ts).
        sandbox: withoutClaudeCredentials(agentSandbox(scope, ssh.path, bridge.path)),
        // 'project' serve per CLAUDE.md (e skill e comandi del repo); hook, permessi, server MCP e agenti dei file
        // li spegne sessionLockdown, così un .claude/settings.json o un .mcp.json del repo non decide niente.
        settingSources: ['user', 'project', 'local'],
        managedSettings: sessionLockdown(),
        // snapshot: le istruzioni registrate al primo giro si riusano uguali a ogni ripresa della sessione.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: rules.join('\n'), snapshot: true },
        mcpServers: { ...pcServers, ...projectMcpServers(row.id, dir), [CREDENTIALS_SERVER]: credServer, [SYSTEM_SERVER]: sysServer, [TOOLS_SERVER]: toolsServer, [ORCHESTRATOR_SERVER]: orchServer },
        // Confinamento su ogni strumento, prima delle regole di permesso; sub-agent solo con i modelli consentiti
        // nelle Impostazioni (riletti a ogni sub-agent).
        hooks: {
          PreToolUse: [
            confineHook(scope, (tool, input, reason) => say(thread, 'tool', `✗ bloccato · ${summarizeTool(tool, input)} (${reason})`)),
            ...(subagentModelHook(() => settings().subagentModels, (from, to) => say(thread, 'tool', `↳ sub-agent su ${to} invece di ${from} (modelli consentiti in Impostazioni › Chat)`)).PreToolUse ?? []),
          ],
        },
        abortController: state.abort,
        includePartialMessages: true,
        // Il ragionamento del modello in chiaro, riassunto dall'API (di serie arriva vuoto): blocco «Ragionamento».
        thinking: { type: 'adaptive', display: 'summarized' },
        // A fine giro Claude suggerisce il prossimo messaggio (una chiamata in più, sulla cache del giro): si spegne
        // dalle Impostazioni › Chat.
        promptSuggestions: settings().promptSuggestions,
        // Compressione automatica quando il contesto si riempie, come in Claude Code (si spegne dalle Impostazioni).
        // Niente messaggi diretti tra sessioni (cross-session messaging di Claude Code): solo Ciccio, l'orchestratore,
        // parla con le chat (scrivi_ad_agente). Gli agenti non scrivono ad altre sessioni e non ne ricevono.
        // La memoria del progetto sta nella sua cartella (confine.ts), non in ~/.claude/projects.
        settings: { autoMemoryDirectory: memoryDir(row.id), autoCompactEnabled: settings().autoCompact, ...(settings().autoCompactWindow ? { autoCompactWindow: settings().autoCompactWindow } : {}), crossSessionInbound: 'refuse' },
        // E niente EnterWorktree/ExitWorktree: i worktree li gestisce Ciccio (uno per chat), così File e Modifiche li seguono.
        disallowedTools: ['ListAgents', 'SendMessage', 'EnterWorktree', 'ExitWorktree'],
        // Connettori di claude.ai solo se l'utente li ha accesi per il progetto e c'è il login dell'abbonamento.
        env: agentEnv,
      },
    });
    const ctx = contextTracker();
    let noted = false;
    for await (const msg of q) {
      // Chi ha fatto partire il giro, per i consumi (il transcript dice solo che è arrivato un prompt).
      if (!noted && 'session_id' in msg && msg.session_id) { noted = true; noteTurn(msg.session_id, startedAt, origin); }
      if (msg.type === 'result') { gotResult = true; stats = turnStats(msg); }
      handleMessage({ ...thread, path: dir }, state, msg);
      // Comandi con «/» del progetto, per l'elenco nel campo di testo: dalla sessione appena partita.
      if (msg.type === 'system' && msg.subtype === 'init') void q.supportedCommands().then((l) => saveCommands(row.id, l)).catch(() => undefined);
      if (msg.type === 'system' && msg.subtype === 'commands_changed') saveCommands(row.id, msg.commands);
      recordUsage(msg);
      ctx.see(msg);
      // A fine giro: quanto contesto occupa la sessione.
      if (msg.type === 'result') {
        const u = ctx.result(msg);
        if (u) store.updateChat(chatId, { context_used: u.used, context_max: u.max });
      }
      // A fine giro, con i connettori accesi, legge quali risultano collegati.
      if (msg.type === 'result' && connectors) {
        try {
          mcpSeen.set(row.id, (await q.mcpServerStatus()).map((m) => ({ name: m.name.replace(/^claude\.ai /, ''), status: m.status })));
        } catch { /* stato non disponibile */ }
      }
      if (msg.type === 'result') finish();
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!state.abort.signal.aborted && !gotResult) {
      store.updateChat(chatId, { last_error: text });
      say(thread, 'error', text);
    }
  } finally {
    finish();
    dropTail(chatId, state.abort);
  }
}

/** Token e costo di un giro dal risultato: modelUsage somma tutti i modelli usati (sub-agent compresi). */
function turnStats(msg: Extract<SDKMessage, { type: 'result' }>): TurnStats {
  let tokensIn = 0, tokensOut = 0;
  for (const m of Object.values(msg.modelUsage ?? {})) {
    tokensIn += (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
    tokensOut += m.outputTokens ?? 0;
  }
  return { durationMs: msg.duration_ms ?? 0, tokensIn, tokensOut, costUsd: msg.total_cost_usd ?? 0 };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string' ? c.text : c && typeof c === 'object' && 'type' in c ? `[${String(c.type)}]` : '')).join('\n');
  }
  return '';
}

/** Traduce i messaggi dell'SDK in chat, stato in diretta e risultati degli strumenti. Usata anche da Ciccio. */
export function handleMessage(t: Thread & { path: string }, state: Running, msg: SDKMessage, replyRole: MessageRole = 'agent') {
  const { chatId, agentId } = t;
  // Strumenti in corso, anche dei sub-agent: servono a capire se il giro lavora o aspetta solo l'utente.
  if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'tool_use') state.inFlight.set(b.id, msg.parent_tool_use_id ?? null);
  if (msg.type === 'user' && Array.isArray(msg.message.content)) {
    for (const b of msg.message.content) if (typeof b === 'object' && b.type === 'tool_result') state.inFlight.delete(b.tool_use_id);
  }
  if (msg.type === 'result') state.inFlight.clear();
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const m = msg.compact_metadata;
    const k = (n?: number) => (n ? `${Math.round(n / 1000)}k` : '?');
    say(t, 'tool', `conversazione compressa${m.trigger === 'auto' ? ' in automatico' : ''}: da ${k(m.pre_tokens)} a ${k(m.post_tokens)} token`);
    // Il contesto nuovo va subito alla pagina: altrimenti l'avviso «Comprimi» restava con la percentuale di prima
    // finché non si ricaricava.
    if (m.post_tokens != null) { store.updateChat(chatId, { context_used: m.post_tokens }); publish(agentId); }
  }
  if (msg.type === 'system' && msg.subtype === 'init') {
    mcpSeen.set(agentId, msg.mcp_servers.map((m) => ({ name: m.name, status: m.status, source: m.source })));
  }
  // Flusso in diretta: fase e testo che l'agente sta scrivendo.
  if (msg.type === 'stream_event' && !msg.parent_tool_use_id) {
    const ev = msg.event;
    if (ev.type === 'message_start') { state.live = { chatId, agentId, phase: 'thinking', text: '' }; emitLive(state, true); }
    if (ev.type === 'content_block_start') {
      const kind = ev.content_block.type;
      if (kind === 'text') state.live = { ...state.live, phase: 'writing' };
      else if (kind === 'tool_use') state.live = { ...state.live, phase: 'tool', tool: ev.content_block.name };
      else if (kind === 'thinking') state.live = { ...state.live, phase: 'thinking', thinking: '' };
      else state.live = { ...state.live, phase: 'thinking' };
      emitLive(state, true);
    }
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      state.live = { ...state.live, phase: 'writing', text: state.live.text + ev.delta.text };
      emitLive(state);
    }
    // Riassunto del ragionamento, a pezzi (con display 'summarized'; senza, i pezzi arrivano vuoti).
    if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
      state.live = { ...state.live, phase: 'thinking', thinking: (state.live.thinking ?? '') + ev.delta.thinking };
      emitLive(state);
    }
    return;
  }
  // Prossimo messaggio suggerito: arriva dopo il risultato, a giro già chiuso.
  if (msg.type === 'prompt_suggestion') { setSuggestion(chatId, msg.suggestion); return; }
  if ('session_id' in msg && typeof msg.session_id === 'string' && msg.session_id) {
    const chat = store.chat(chatId);
    if (chat && chat.session_id !== msg.session_id) store.updateChat(chatId, { session_id: msg.session_id });
  }
  if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
    for (const block of msg.message.content) {
      if (block.type === 'thinking' && block.thinking.trim()) say(t, 'thinking', block.thinking.trim());
      if (block.type === 'text' && block.text.trim()) say(t, replyRole, block.text.trim());
      if (block.type === 'tool_use') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
          const todos = (input.todos as TodoItem[]).map((x) => ({ content: String(x.content ?? ''), status: x.status }));
          say(t, 'todo', `Compiti: ${todos.filter((x) => x.status === 'completed').length} di ${todos.length}`, { kind: 'todo', todos });
        } else {
          const meta: ToolMeta = { kind: 'tool', tool: block.name, target: toolTarget(block.name, input, t.path), input };
          const m = say(t, 'tool', `${block.name}: ${meta.target}`, meta);
          state.tools.set(block.id, m.id);
        }
      }
    }
    store.updateChat(chatId, { last_activity: Date.now() });
    store.updateAgent(agentId, { last_activity: Date.now() });
    publish(agentId);
    // Il testo ora è un messaggio salvato: la parte in diretta riparte da zero.
    const lastTool = [...msg.message.content].reverse().find((b) => b.type === 'tool_use');
    state.live = lastTool && lastTool.type === 'tool_use'
      ? { chatId, agentId, phase: 'tool', tool: lastTool.name, text: '' }
      : { chatId, agentId, phase: 'thinking', text: '' };
    emitLive(state, true);
  }
  // I risultati degli strumenti arrivano come messaggio "user" con blocchi tool_result.
  if (msg.type === 'user' && !msg.parent_tool_use_id && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (typeof block !== 'object' || block.type !== 'tool_result') continue;
      const id = state.tools.get(block.tool_use_id);
      if (id == null) continue;
      const current = store.message(id);
      if (!current || current.meta?.kind !== 'tool') continue;
      const meta: ToolMeta = { ...current.meta, output: resultText(block.content).slice(0, 8000), isError: !!block.is_error, done: true };
      const updated = store.updateMessageMeta(id, meta);
      if (updated) bus.emit({ type: 'messageUpdate', message: updated });
    }
  }
  if (msg.type === 'result') {
    if (msg.subtype === 'success' && !msg.is_error) {
      store.updateChat(chatId, { last_result: msg.result, last_error: null });
    } else {
      const detail = msg.subtype === 'success' ? msg.result : `${msg.subtype}${'errors' in msg && Array.isArray(msg.errors) ? `: ${msg.errors.join('; ')}` : ''}`;
      store.updateChat(chatId, { last_error: detail || 'Errore durante l’esecuzione' });
      say(t, 'error', detail || 'Errore durante l’esecuzione');
    }
  }
}

/** Risposta dell'utente a un permesso; con «Consenti sempre» salva anche la regola del progetto. */
function verdictFor(approval: Approval | undefined, allow: boolean, always: boolean): PermissionResult {
  // "Consenti sempre" vale per tutto il progetto, come le regole locali di Claude Code.
  // Si salva la regola mostrata nella card, non una ricalcolata. Senza regola (azioni dei connettori, permessi che dà
  // solo l'utente, richieste di prima di questa versione) «sempre» vale come una volta sola.
  const rule = approval?.rule;
  if (allow && always && approval && rule && !ONLY_OWNER.has(approval.tool) && store.agent(approval.agentId)) {
    const rules = allowRules(approval.agentId);
    if (!rules.includes(rule)) store.updateAgent(approval.agentId, { allow_rules: JSON.stringify([...rules, rule]) });
  }
  // Proposte di strumenti: lo strumento che chiede deve sapere se è «Consenti sempre» (l'unico che lo salva).
  const sempre = approval && PROPOSALS.has(approval.tool) ? { updatedInput: { ...(approval.input as Record<string, unknown>), sempre: always } } : {};
  return allow ? { behavior: 'allow', ...sempre } : { behavior: 'deny', message: `${OWNER} ha rifiutato questo permesso.` };
}

export function decideApproval(id: string, allow: boolean, always = false): boolean {
  const held = waiting(id);
  if (held) {
    const [chatId, state] = held;
    const resolve = state.pending.get(id)!;
    const approval = store.pendingApprovals(chatId).find((a) => a.id === id);
    // Una domanda si chiude solo con le risposte: «Rifiuta» la salta, «Consenti» non vale.
    if (approval?.tool === ASK_TOOL) return allow ? false : answerQuestion(id, {});
    const summary = approval?.summary ?? 'permesso';
    const thread: Thread = { chatId, agentId: approval?.agentId ?? state.live.agentId };
    const verdict = verdictFor(approval, allow, always);
    state.pending.delete(id);
    store.setApproval(id, allow ? 'allowed' : 'denied');
    // Le notifiche dell'app desktop con i pulsanti spariscono anche quando si decide dalla chat.
    if (approval) bus.emit({ type: 'approval', approval: { ...approval, status: allow ? 'allowed' : 'denied' } });
    resolve(verdict);
    // Una riga discreta nel registro, non un messaggio in chat (la prima riga: le proposte ne hanno diverse).
    say(thread, 'tool', `${allow ? '✓ approvato' : '✗ rifiutato'} · ${summary.split('\n')[0]}`);
    publish(thread.agentId);
    return true;
  }
  // Card riproposta dopo un riavvio: il giro riprende quando l'utente ha risposto a tutte quelle della chat.
  const found = findParked(id);
  if (!found) { closeOrphan(id); return false; }
  const [p, approval] = found;
  if (approval.tool === ASK_TOOL) return allow ? false : answerQuestion(id, {});
  const verdict = verdictFor(approval, allow, always);
  const first = approval.summary.split('\n')[0];
  if (allow) preapproved.set(p.thread.chatId, [...(preapproved.get(p.thread.chatId) ?? []), { key: approvalKey(approval.tool, approval.input as Record<string, unknown>), result: verdict }]);
  say(p.thread, 'tool', `${allow ? '✓ approvato' : '✗ rifiutato'} · ${first}`);
  closeParked(p, approval, allow ? 'allowed' : 'denied', allow
    ? `${OWNER} ha consentito: ${first}. Rifai quel passo così com'era (stesso strumento, stessi parametri): passa senza chiedere di nuovo.`
    : `${OWNER} ha rifiutato: ${first}. Vai avanti senza.`);
  return true;
}

export function stopChat(chatId: string): boolean {
  const chat = store.chat(chatId);
  if (!chat) return false;
  // Richieste riproposte dopo un riavvio: fermando la chat non c'è più un giro da riprendere.
  const wasParked = !!staleNote(chatId);
  const idx = queue.findIndex((q) => q.chatId === chatId);
  if (idx >= 0) {
    const [item] = queue.splice(idx, 1);
    // Un messaggio di una routine tolto dalla coda: la sua esecuzione finisce qui, fermata.
    if (item.routine) agentEvents.finished({ chatId, agentId: chat.agent_id, aborted: true, error: null, from: 'user', routine: item.routine });
  }
  const state = running.get(chatId);
  if (!state) { publish(chat.agent_id); return idx >= 0 || wasParked; }
  state.abort.abort();
  say(threadOf(chat), 'tool', 'agente fermato');
  return true;
}

/** Ferma tutte le chat di un progetto (per Ciccio). */
export function stopAgent(agentId: string): boolean {
  return store.chats(agentId).map((c) => stopChat(c.id)).some(Boolean);
}

/** Cambia il livello di autorizzazione della chat; vale dalla prossima richiesta di permesso. */
export function setPermission(chatId: string, level: PermissionLevel) {
  const chat = store.chat(chatId);
  if (!chat) return;
  store.updateChat(chatId, { permission: level });
  say(threadOf(chat), 'tool', `livello di autorizzazione: ${PERMISSION_LEVELS.find((l) => l.key === level)?.label ?? level}`);
  publish(chat.agent_id);
}

/** Accende o spegne i connettori di claude.ai per le chat del progetto; vale dal prossimo messaggio. */
export function setConnectors(agentId: string, enabled: boolean) {
  store.updateAgent(agentId, { connectors: enabled ? 1 : 0 });
  publish(agentId);
}

/** Nasconde o rimostra un progetto in Ciccio (solo qui: repo e cartella restano come sono). */
export function setHidden(agentId: string, hidden: boolean) {
  store.updateAgent(agentId, { hidden: hidden ? 1 : 0 });
  publish(agentId);
}

/** Accende o spegne gli strumenti dei PC collegati per le chat del progetto; vale dal prossimo messaggio. */
export function setPcTools(agentId: string, enabled: boolean) {
  store.updateAgent(agentId, { pc_tools: enabled ? 1 : 0 });
  publish(agentId);
}

/** Modello ed effort della chat: valgono dal prossimo messaggio. */
export function setModel(chatId: string, model: string | null, effort: Effort | null) {
  const chat = store.chat(chatId);
  if (!chat) return;
  store.updateChat(chatId, { model, effort });
  publish(chat.agent_id);
}

/** Aggiunge una regola "consenti sempre" al progetto. */
export function addRule(agentId: string, rule: string) {
  const clean = rule.trim().slice(0, 200);
  const rules = allowRules(agentId);
  if (clean && !rules.includes(clean)) store.updateAgent(agentId, { allow_rules: JSON.stringify([...rules, clean]) });
}

export function removeRule(agentId: string, rule: string) {
  store.updateAgent(agentId, { allow_rules: JSON.stringify(allowRules(agentId).filter((r) => r !== rule)) });
}

/** Rinomina il progetto solo in Ciccio; stringa vuota = torna al nome del repo. */
export function renameAgent(agentId: string, name: string) {
  const clean = name.trim().slice(0, 60);
  store.updateAgent(agentId, { display_name: clean || null });
  publish(agentId);
}

/** Rinomina una chat; da qui in poi il titolo non cambia più da solo. */
export function renameChat(chatId: string, title: string) {
  const chat = store.chat(chatId);
  const clean = title.trim().slice(0, 80);
  if (!chat || !clean) return;
  store.updateChat(chatId, { title: clean, auto_title: 0 });
  publish(chat.agent_id);
}

/** Archivia una chat: sparisce dall'elenco, i messaggi restano; scrivendole torna visibile. */
export function archiveChat(chatId: string) {
  const chat = store.chat(chatId);
  if (!chat) return;
  stopChat(chatId);
  store.updateChat(chatId, { archived: 1 });
  // Il worktree della chat si toglie se non ha modifiche da salvare (branch e PR restano); altrimenti resta.
  const row = store.agent(chat.agent_id);
  if (chat.worktree && row && removeChatWorktree(row.path, chat.worktree)) store.updateChat(chatId, { worktree: null });
  publish(chat.agent_id);
}

/** Comprime la conversazione della chat (come /compact in Claude Code): Claude riassume e libera contesto. */
export function compactChat(chatId: string): 'started' | 'queued' | 'empty' {
  const chat = store.chat(chatId);
  if (!chat) throw new Error('Chat sconosciuta');
  if (!chat.session_id) return 'empty';
  say(threadOf(chat), 'tool', 'comprimo la conversazione…');
  if (draining || running.has(chatId) || busySlots() >= settings().maxActive) {
    queue.push({ chatId, text: '/compact', from: 'user' });
    publish(chat.agent_id);
    return 'queued';
  }
  void run(chatId, '/compact', 'user');
  return 'started';
}

/** Nuova sessione nella stessa chat (come /clear): i messaggi restano qui, Claude riparte senza contesto. */
export function newSession(chatId: string) {
  const chat = store.chat(chatId);
  if (!chat) throw new Error('Chat sconosciuta');
  stopChat(chatId);
  dropTail(chatId);
  suggestions.delete(chatId);
  store.updateChat(chatId, { session_id: null, context_used: null, context_max: null, last_error: null, last_result: null });
  say(threadOf(chat), 'tool', 'nuova sessione: Claude riparte senza il contesto precedente (i messaggi restano qui)');
  publish(chat.agent_id);
}

/** Riprende una chat bloccata da un errore cancellando l'errore. */
export function clearError(chatId: string) {
  const chat = store.chat(chatId);
  if (!chat) return;
  store.updateChat(chatId, { last_error: null });
  publish(chat.agent_id);
}

export function chatView(chatId: string): ChatView | null {
  const chat = store.chat(chatId);
  return chat ? computeChat(chat) : null;
}
