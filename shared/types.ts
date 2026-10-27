// Tipi condivisi tra server e web.

export type AgentStatus = 'wait' | 'work' | 'block' | 'stale' | 'idle';

/** Livello di autorizzazione della chat, come in Claude Code. */
export type PermissionLevel = 'manual' | 'edits' | 'auto' | 'bypass';

export const PERMISSION_LEVELS: { key: PermissionLevel; label: string; hint: string }[] = [
  { key: 'manual', label: 'Manuale', hint: 'Chiede conferma per ogni comando e modifica.' },
  { key: 'edits', label: 'Accetta modifiche', hint: 'Modifica da solo i file del repo; per i comandi chiede.' },
  { key: 'auto', label: 'Auto', hint: 'Fa da solo; chiede solo per azioni pericolose (sudo, rm -rf fuori progetto, DROP, comandi distruttivi via ssh…).' },
  { key: 'bypass', label: 'Ignora autorizzazioni', hint: 'Fa tutto senza chiedere. Restano bloccati solo il push su main e il force push.' },
];

/** Una chat su un progetto: come una sessione di Claude Code, con contesto e impostazioni suoi. */
export interface ChatView {
  id: string;
  agentId: string;
  title: string;
  status: AgentStatus;
  line: string;
  lastReply: number | null;
  lastActivity: number | null;
  createdAt: number;
  running: boolean;
  /** Cosa fa il giro in corso: «work» chiama il modello o esegue strumenti, «wait» è fermo su una risposta dell'utente. */
  activity: ChatActivity;
  queued: boolean;
  pendingApprovals: number;
  permission: PermissionLevel;
  model: string;
  effort: Effort;
  /** Contesto della sessione dopo l'ultimo giro (token usati, finestra, percentuale); null se ancora nessun giro. */
  context: ContextInfo | null;
  /** Prossimo messaggio suggerito da Claude a fine giro (come in Claude Code); null se non c'è. */
  suggestion: string | null;
}

export interface ContextInfo { used: number; max: number; pct: number }

/** Al lavoro, ferma ad aspettare l'utente (permessi, domande) oppure senza giro in corso. */
export type ChatActivity = 'work' | 'wait' | 'idle';

export interface AgentView {
  /** Nome della cartella del repo: identificativo stabile. */
  id: string;
  /** Nome mostrato: quello scelto dall'utente, oppure l'id. */
  name: string;
  /** Epoch ms dell'ultima risposta dell'agente (null se non ha mai risposto). */
  lastReply: number | null;
  status: AgentStatus;
  /** Una riga: cosa sta facendo o cosa aspetta. */
  line: string;
  /** Epoch ms dell'ultima attività (sessione o ultimo commit). */
  lastActivity: number | null;
  running: boolean;
  queued: boolean;
  pendingApprovals: number;
  hasStatusMd: boolean;
  /** Chat del progetto, dalla più recente. */
  chats: ChatView[];
  /** Connettori di claude.ai e strumenti del PC accesi per le chat del progetto. */
  connectors: boolean;
  pcTools: boolean;
  /** Nascosto in Ciccio: non compare in dashboard, elenco chat e riepilogo. */
  hidden: boolean;
}

/** `thinking`: il riassunto del ragionamento del modello (blocco «Ragionamento» in chat). */
export type MessageRole = 'user' | 'agent' | 'ciccio' | 'tool' | 'todo' | 'error' | 'thinking';

/** Uno strumento usato dall'agente (Read, Bash, Edit…), con il suo risultato. */
export interface ToolMeta {
  kind: 'tool';
  tool: string;
  /** File, comando o pattern su cui lavora, già accorciato. */
  target: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  done?: boolean;
}

export interface TodoItem { content: string; status: 'pending' | 'in_progress' | 'completed' }
export interface TodoMeta { kind: 'todo'; todos: TodoItem[] }

export interface Attachment { name: string; path: string; size: number }
/** Messaggio dell'utente; `routine`: mandato da una routine a nome suo (nome della routine). */
export interface UserMeta { kind: 'user'; attachments: Attachment[]; routine?: string }

/** Comando con «/» di una chat (skill o comando di Claude Code), come lo elenca l'Agent SDK. */
export interface SlashCommandView { name: string; description: string; /** Argomenti attesi, per esempio «<file>». */ hint?: string }

/** Avviso spontaneo di Ciccio su una chat di un agente (giro finito, permesso richiesto). */
export interface NoticeMeta { kind: 'notice'; agentId: string; chatId: string; chatTitle: string; tone: 'done' | 'wait' | 'block'; /** Avviso di un permesso o di una domanda: l'app desktop ci mette i pulsanti. */ approvalId?: string }

export type MessageMeta = ToolMeta | TodoMeta | UserMeta | NoticeMeta;

export interface ChatMessage {
  id: number;
  /** Chat a cui appartiene, oppure CICCIO_THREAD per la conversazione con Ciccio. */
  chatId: string;
  /** Progetto della chat (CICCIO_THREAD per Ciccio). */
  agentId: string;
  role: MessageRole;
  text: string;
  ts: number;
  meta?: MessageMeta;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const MODELS: { id: string; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Modelli che un agente può dare ai suoi sub-agent (valori del campo model dello strumento Agent). */
export type SubagentModel = 'haiku' | 'sonnet' | 'opus' | 'fable';
export const SUBAGENT_MODELS: { id: SubagentModel; label: string; hint: string }[] = [
  { id: 'haiku', label: 'Haiku', hint: 'cercare e leggere, il più economico' },
  { id: 'sonnet', label: 'Sonnet', hint: 'lavoro normale' },
  { id: 'opus', label: 'Opus', hint: 'parti difficili, il più costoso' },
  { id: 'fable', label: 'Fable', hint: 'come Opus' },
];

/** Dettagli di un agente per la pagina chat. */
export interface AgentInfo {
  branch: string | null;
  /** Cartella in cui lavora la chat (o il progetto, senza chat). */
  dir: string;
  /** La chat lavora nel suo worktree git, non nella cartella del progetto. */
  worktree: boolean;
  /** C'è un CLAUDE.md nella cartella: Claude lo legge a inizio sessione. */
  claudeMd: boolean;
  /** Soglia (token) oltre cui la sessione si comprime da sola. */
  autoCompactWindow: number;
  statusMd: string | null;
  allowRules: string[];
  mcpServers: string[];
  /** Connettori di claude.ai attivi per le chat del progetto (interruttore nelle impostazioni). */
  connectors: boolean;
  /** Server MCP visti all'avvio dell'ultima sessione, con il loro stato. */
  mcpStatus: { name: string; status: string; source?: string }[];
  /** Strumenti dei PC collegati (companion) disponibili per le chat del progetto. */
  pcTools: boolean;
  /** Strumenti su misura approvati dall'utente (proposti dagli agenti). */
  tools: ProjectToolView[];
}

/** Uno strumento su misura del progetto: un comando del server o un server MCP, approvato con «Consenti sempre». */
export interface ProjectToolView {
  name: string;
  kind: 'comando' | 'mcp';
  description: string;
  /** Comando esatto (programma e argomenti) o indirizzo, come approvato. */
  detail: string;
  /** Approvato come sola lettura: in Auto parte senza chiedere. */
  readOnly: boolean;
  /** Nome per le regole «consenti sempre» (mcp__…). */
  toolName: string;
  createdAt: number;
  /** Chat da cui è arrivata la proposta. */
  proposedIn: string | null;
  uses: number;
  lastUsed: number | null;
}

/** Uno strumento MCP che un PC collegato mette a disposizione. */
export interface CompanionTool { name: string; description?: string; readOnly?: boolean }
export interface CompanionServer { name: string; status: 'online' | 'offline'; error?: string; tools: CompanionTool[] }

/** Un PC con il companion: il dispositivo registrato e, se è acceso, i suoi server MCP. */
export interface CompanionView {
  id: string;
  /** Nome del dispositivo (es. "mac"): gli strumenti si chiamano mcp__pc_<nome>__<server>_<strumento>. */
  name: string;
  /** Nome del server MCP per le sessioni agente (pc_<nome>). */
  mcpName: string;
  online: boolean;
  platform: string | null;
  version: string | null;
  createdAt: number;
  lastSeen: number | null;
  /** Il PC mostra gli avvisi di Ciccio come notifiche del sistema: il browser può non mostrarli. */
  notifications: boolean;
  /** 1Password su quel PC (agent SSH, CLI op); null se il PC è spento. */
  onePassword: { sshAgent: boolean; cli: boolean } | null;
  servers: CompanionServer[];
}

/** App desktop «Ciccio» collegata (Mac o Windows): finestra con Ciccio e notifiche native. */
export interface DesktopAppView {
  id: string;
  name: string;
  online: boolean;
  platform: string | null;
  version: string | null;
  createdAt: number;
  lastSeen: number | null;
  /** Companion dello stesso PC a cui l'app toglie le notifiche (nome), se c'è. */
  companion: string | null;
}

export interface DiffFile { path: string; added: number; removed: number; patch: string }

/** Uso dell'abbonamento Claude: finestra di 5 ore e settimanale (utilization 0..1, resetsAt in epoch ms). */
export interface UsageWindow { utilization: number; resetsAt: number }
export interface Usage { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; updatedAt: number }

/**
 * Come si collegano le sessioni a Claude: login di claude.ai (abbonamento: limiti di 5 ore e settimana, connettori e
 * skill dell'account) oppure nessun login. Le chiavi API non si usano.
 */
export type AuthMode = 'subscription' | 'none';
/** Uso di Claude per la pagina: le finestre dell'abbonamento. */
export interface UsageState { auth: AuthMode; usage: Usage | null }

/** Cosa sta facendo l'agente in questo istante, con il testo che sta scrivendo. */
export interface LiveState {
  chatId: string;
  agentId: string;
  phase: 'thinking' | 'tool' | 'writing' | 'idle';
  tool?: string;
  text: string;
  /** Riassunto del ragionamento mentre il modello pensa (vuoto finché non arriva il primo pezzo). */
  thinking?: string;
}

export interface Approval {
  id: string;
  chatId: string;
  agentId: string;
  tool: string;
  summary: string;
  input: unknown;
  ts: number;
  status: 'pending' | 'allowed' | 'denied';
  /** Regola esatta che «Consenti sempre» salva nel progetto (es. «Bash:npm test»); null = niente «sempre». */
  rule?: string | null;
}

/** Strumento con cui Claude fa domande a scelte all'utente (AskUserQuestion di Claude Code): passa dalle approvazioni. */
export const ASK_TOOL = 'AskUserQuestion';

export interface QuestionOption { label: string; description: string }
export interface Question {
  question: string;
  /** Etichetta breve (max 12 caratteri). */
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Domande di una richiesta AskUserQuestion, controllate; null se non è una domanda valida. */
export function questionsOf(a: { tool: string; input: unknown }): Question[] | null {
  if (a.tool !== ASK_TOOL || !a.input || typeof a.input !== 'object') return null;
  const raw = (a.input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return null;
  const list = raw.flatMap((q): Question[] => {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string') return [];
    const options = Array.isArray(q.options)
      ? (q.options as unknown[]).flatMap((o) => (o && typeof o === 'object' && typeof (o as QuestionOption).label === 'string'
        ? [{ label: (o as QuestionOption).label, description: typeof (o as QuestionOption).description === 'string' ? (o as QuestionOption).description : '' }]
        : []))
      : [];
    return [{ question: q.question, header: typeof q.header === 'string' ? q.header : '', options, multiSelect: q.multiSelect === true }];
  });
  return list.length ? list : null;
}

export type RecapTone ='wait' | 'block' | 'done' | 'stale' | 'work' | 'info';

export interface Recap {
  day: string;
  headline: string;
  lines: { tone: RecapTone; text: string }[];
  ts: number;
}

/** Fasi di Ciccio, mostrate con gli orb. */
export type CiccioPhase = 'idle' | 'thinking' | 'connecting' | 'speaking';

/** Impostazioni dell'app (pagina Impostazioni; Ciccio le può leggere e cambiare). */
export interface AppSettings {
  /** Modello ed effort di Ciccio. */
  ciccioModel: string;
  ciccioEffort: Effort;
  /** Modello ed effort dei giri a voce: più rapidi, per una conversazione che non aspetta. */
  ciccioVoiceModel: string;
  ciccioVoiceEffort: Effort;
  /** Avvisi spontanei di Ciccio. */
  noticeDone: boolean;
  noticeApprovals: boolean;
  noticeErrors: boolean;
  /** Ciccio legge a voce le risposte quando gli hai parlato. */
  voiceReplies: boolean;
  /** Valori di partenza delle chat nuove. */
  defaultPermission: PermissionLevel;
  defaultModel: string;
  defaultEffort: Effort;
  /** Modelli consentiti per i sub-agent degli agenti: un altro modello viene sostituito con il più vicino. */
  subagentModels: SubagentModel[];
  /**
   * PC da cui prendere chiavi SSH e segreti di 1Password (id del dispositivo del companion).
   * Vuoto = automatico: il PC collegato da più tempo. Scelto un PC, si usa solo quello: se è spento, niente 1Password.
   */
  onePasswordDevice: string;
  /** Chat al lavoro insieme; le altre aspettano in coda. */
  maxActive: number;
  /** Ora del riepilogo del mattino, nel fuso di timeZone. */
  recapHour: number;
  /** Fuso orario di Ciccio (CICCIO_TZ sul server): solo lettura. */
  timeZone: string;
  /** Il servizio voce del server (Whisper e Piper) risponde: solo lettura. Spento, valgono browser e dispositivo. */
  voiceServer: boolean;
  /** Compressione automatica quando il contesto si riempie (come in Claude Code). */
  autoCompact: boolean;
  /**
   * Soglia della compressione automatica, in token (0 = quella del modello, cioè quasi al pieno di 1 milione).
   * Una chat a 700k rilegge 700k a ogni chiamata: comprimere prima costa una chiamata e poi fa risparmiare a ogni giro.
   */
  autoCompactWindow: number;
  /**
   * Sessione leggera di Ciccio: dopo un'ora di pausa (quindi anche ogni mattina) o oltre 150k di contesto riparte con
   * una sessione nuova e gli ultimi messaggi come promemoria, invece di riprendere e ripagare tutta la conversazione.
   */
  ciccioLightSession: boolean;
  /**
   * Prompt suggerito a fine giro (come in Claude Code). Costa una chiamata in più per giro, che rilegge dalla
   * cache tutto il contesto della chat: su chat grandi si fa sentire sul limite di 5 ore.
   */
  promptSuggestions: boolean;
  /** Oltre questa percentuale di contesto la chat propone Comprimi o Nuova sessione. */
  contextWarn: number;
  /** Sensibilità del microfono nella voce: quanto forte devi parlare perché ti senta. */
  micSensitivity: 'bassa' | 'media' | 'alta';
  /** Velocità della voce di Ciccio. */
  voiceSpeed: 'lenta' | 'normale' | 'veloce';
  /** Ciccio usa le skill installate sul server. */
  ciccioSkills: boolean;
  /** Trascrizione: Whisper sul server (base veloce, small più preciso) o il riconoscimento del browser. */
  sttEngine: 'whisper-base' | 'whisper-small' | 'browser' | 'openai' | 'elevenlabs' | 'deepgram';
  /** Voce di Ciccio: Piper sul server (Paola o Riccardo) o la voce del dispositivo. */
  ttsEngine: 'piper-paola' | 'piper-riccardo' | 'device' | 'openai' | 'elevenlabs' | 'deepgram';
  /** Voce scelta per i servizi esterni (id della voce OpenAI o ElevenLabs). */
  ttsVoice: string;
  /** Routine: oltre questa percentuale della finestra di 5 ore le esecuzioni programmate saltano (100 = mai). */
  routineUsageLimit: number;
  /**
   * Word, Excel e PowerPoint nel visore di Office online di Microsoft, che scarica il file dal server (serve un indirizzo
   * pubblico in CICCIO_ORIGINS). Spento: Excel e Word si leggono qui, senza la grafica del file.
   */
  officeOnline: boolean;
}

/** Esito di un'esecuzione di una routine. */
export type RoutineRunStatus = 'in_corso' | 'in_coda' | 'ok' | 'errore' | 'fermata' | 'saltata' | 'interrotta';

/** Consumo di un insieme di esecuzioni: token letti e scritti (cache compresa) e costo equivalente API in dollari. */
export interface RoutineUsage { runs: number; tokensIn: number; tokensOut: number; costUsd: number }

export interface RoutineRun {
  id: string;
  routineId: string;
  ts: number;
  status: RoutineRunStatus;
  chatId: string | null;
  note: string | null;
  durationMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** Finestra di 5 ore all'inizio e alla fine (0..1), se nota. */
  usageBefore: number | null;
  usageAfter: number | null;
  /** Lanciata a mano («Lancia ora»). */
  manual: boolean;
}

/** Routine: un messaggio che Ciccio manda da solo a un progetto, a orari fissi. */
export interface RoutineView {
  id: string;
  agentId: string;
  name: string;
  text: string;
  cron: string;
  /** Il cron in italiano (es. «ogni giorno alle 08:00»). */
  when: string;
  /** Chat fissa; null = una chat nuova (senza contesto) a ogni esecuzione. */
  chatId: string | null;
  chatTitle: string | null;
  /** Livello delle chat nuove della routine; null = quello predefinito delle chat nuove. */
  permission: PermissionLevel | null;
  enabled: boolean;
  createdBy: 'utente' | 'agente' | 'ciccio';
  createdAt: number;
  nextRun: number | null;
  /** Un'esecuzione è al lavoro o in coda; `waiting`: la prossima aspetta che finisca. */
  active: boolean;
  waiting: boolean;
  last: RoutineRun | null;
  total: number;
  week: RoutineUsage;
  month: RoutineUsage;
}

/** Servizio vocale esterno collegabile (chiave salvata solo sul server). */
export interface VoiceProviderView { id: 'openai' | 'elevenlabs' | 'deepgram'; name: string; connected: boolean; last4: string | null; stt: boolean; tts: boolean }

/** Skill di Claude Code installata sul server (valida per tutti gli agenti). */
export interface SkillView { id: string; name: string; description: string; source: string | null; installedAt: number; /** Dal tuo account claude.ai (sincronizzata da Claude Code): si gestisce su claude.ai. */ synced?: boolean }

export interface PasskeyView { id: string; name: string; createdAt: number }

export type ServerEvent =
  | { type: 'agent'; agent: AgentView }
  | { type: 'message'; message: ChatMessage }
  | { type: 'messageUpdate'; message: ChatMessage }
  | { type: 'live'; live: LiveState }
  | { type: 'usage'; state: UsageState }
  | { type: 'approval'; approval: Approval }
  | { type: 'ciccio'; phase: CiccioPhase }
  | { type: 'recap'; recap: Recap }
  | { type: 'recapError'; error: string }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'ciccioContext'; context: ContextInfo | null }
  | { type: 'ciccioSuggestion'; suggestion: string | null }
  | { type: 'companions'; companions: CompanionView[] }
  | { type: 'desktopApps'; apps: DesktopAppView[] }
  | { type: 'routines'; routines: RoutineView[] };

export const CICCIO_THREAD = '__ciccio';

/** Un campione delle prestazioni del VPS (Impostazioni › Server). Byte, frazioni 0–1, core. */
export interface ServerSample {
  at: number;
  /** CPU di tutta la macchina, 0–1. */
  cpu: number;
  /** Carico medio di 1 minuto. */
  load: number;
  memUsed: number;
  swapUsed: number;
  diskUsed: number;
  /** Rete in entrata e in uscita, byte al secondo. */
  rx: number;
  tx: number;
  /** Servizio Ciccio con tutti gli agenti: memoria e core usati. */
  groupMem: number;
  groupCpu: number;
}

export interface ServerStats {
  cores: number;
  memTotal: number;
  swapTotal: number;
  diskTotal: number;
  /** Secondi dall'accensione del VPS. */
  uptime: number;
  /** Limiti del servizio Ciccio (MemoryMax, CPUQuota in core); null se non ci sono. */
  groupMemMax: number | null;
  groupCpuMax: number | null;
  /** Ultima ora a 30 secondi e ultime 24 ore a 5 minuti, dal più vecchio. */
  hour: ServerSample[];
  day: ServerSample[];
  /** Programmi che pesano di più adesso (CPU 0–1 di un core, memoria in byte). */
  top: { pid: number; cpu: number; mem: number; name: string; project?: string }[];
  services: { label: string; active: boolean }[];
}
