import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectToolView, RoutineRun, RoutineView, ContextInfo, AppSettings, PasskeyView, CompanionView, DesktopAppView, AgentInfo, AgentView, Approval, Attachment, ChatMessage, ChatView, CiccioPhase, DiffFile, Effort, LiveState, PermissionLevel, Recap, ServerEvent, SlashCommandView, UsageState } from '../../shared/types';
import { setTimeZone } from '../../shared/tz';

async function call<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Sessione scaduta (accesso da internet): si torna alla pagina di accesso.
  if (res.status === 401) window.dispatchEvent(new Event('ciccio:auth'));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Errore ${res.status}`);
  return res.json() as Promise<T>;
}

/** «?chat=…» (o «&»): la chat di cui seguire la cartella. */
const chatQ = (chat: string | undefined, lead: string, tail = '') => (chat ? `${lead}chat=${encodeURIComponent(chat)}${tail}` : '');
/** Indirizzo dei file del repo, a cui si aggiunge il percorso: con la chat, quelli della sua cartella. */
export const fileBaseOf = (id: string, chat?: string) => `/api/agents/${encodeURIComponent(id)}/file?${chatQ(chat, '', '&')}path=`;

export const api = {
  agents: () => call<AgentView[]>('GET', '/api/agents'),
  /** Rilegge la cartella dei progetti: i repo nuovi diventano agenti. */
  syncProjects: () => call<{ ids: string[] }>('POST', '/api/agents/sync'),
  // Chat: più per progetto, come le sessioni di Claude Code.
  thread: (chatId: string) => call<{ messages: ChatMessage[]; approvals: Approval[] }>('GET', `/api/chats/${encodeURIComponent(chatId)}/messages`),
  send: (chatId: string, text: string, attachments: Attachment[] = []) => call<{ result: string }>('POST', `/api/chats/${encodeURIComponent(chatId)}/messages`, { text, attachments }),
  createChat: (agentId: string, title?: string) => call<ChatView>('POST', `/api/agents/${encodeURIComponent(agentId)}/chats`, { title }),
  renameChat: (chatId: string, title: string) => call<ChatView>('POST', `/api/chats/${encodeURIComponent(chatId)}/name`, { title }),
  archiveChat: (chatId: string) => call('POST', `/api/chats/${encodeURIComponent(chatId)}/archive`),
  // `chat`: per una chat con il suo worktree, file, modifiche e STATUS.md sono quelli della sua cartella.
  info: (id: string, chat?: string) => call<AgentInfo>('GET', `/api/agents/${encodeURIComponent(id)}/info${chatQ(chat, '?')}`),
  tree: (id: string, chat?: string) => call<{ files: string[] }>('GET', `/api/agents/${encodeURIComponent(id)}/tree${chatQ(chat, '?')}`),
  diff: (id: string, chat?: string) => call<{ base: string | null; files: DiffFile[] }>('GET', `/api/agents/${encodeURIComponent(id)}/diff${chatQ(chat, '?')}`),
  settings: (chatId: string, model: string, effort: Effort) => call('POST', `/api/chats/${encodeURIComponent(chatId)}/settings`, { model, effort }),
  setConnectors: (id: string, enabled: boolean) => call('POST', `/api/agents/${encodeURIComponent(id)}/connectors`, { enabled }),
  setHidden: (id: string, hidden: boolean) => call<AgentView>('POST', `/api/agents/${encodeURIComponent(id)}/hidden`, { hidden }),
  setPcTools: (id: string, enabled: boolean) => call('POST', `/api/agents/${encodeURIComponent(id)}/pc-tools`, { enabled }),
  // Companion dei PC: dispositivi registrati, token nuovo (mostrato una volta), scollegamento.
  companions: () => call<CompanionView[]>('GET', '/api/companions'),
  createCompanion: (name: string) => call<{ device: CompanionView; token: string; server: string }>('POST', '/api/companions', { name }),
  repairCompanion: (id: string) => call<{ device: CompanionView; token: string; server: string }>('POST', `/api/companions/${encodeURIComponent(id)}/token`),
  removeCompanion: (id: string) => call('POST', `/api/companions/${encodeURIComponent(id)}/remove`),
  // App desktop: conferma del codice mostrato dall'app, elenco, scollegamento.
  desktopApps: () => call<DesktopAppView[]>('GET', '/api/desktop/apps'),
  approveDesktopApp: (code: string) => call<{ app?: DesktopAppView }>('POST', '/api/desktop/pair/approve', { code }),
  removeDesktopApp: (id: string) => call('POST', `/api/desktop/apps/${encodeURIComponent(id)}/remove`),
  removeProjectTool: (id: string, name: string) => call<{ tools: ProjectToolView[] }>('POST', `/api/agents/${encodeURIComponent(id)}/tools/remove`, { name }),
  removeRule: (id: string, rule: string) => call<{ rules: string[] }>('POST', `/api/agents/${encodeURIComponent(id)}/rules/remove`, { rule }),
  /** Indirizzo firmato (un'ora, solo la cartella della pagina) della pagina HTML viva, con i suoi file nella sandbox. */
  viewPage: (id: string, path: string, chat?: string) => call<{ url: string }>('GET', `/api/agents/${encodeURIComponent(id)}/view-token?${chatQ(chat, '', '&')}path=${encodeURIComponent(path)}`),
  /** Visore di Office online per un documento del repo: nel riquadro (embed) e a pagina intera (page); off se è spento. */
  office: (id: string, path: string, chat?: string) => call<{ embed?: string; page?: string; off?: boolean }>('GET', `/api/agents/${encodeURIComponent(id)}/office?${chatQ(chat, '', '&')}path=${encodeURIComponent(path)}`),
  fileUrl: (id: string, path: string, download = false, chat?: string) => `${fileBaseOf(id, chat)}${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  upload: async (id: string, files: File[]): Promise<Attachment[]> => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Errore ${res.status}`);
    return ((await res.json()) as { attachments: Attachment[] }).attachments;
  },
  setPermission: (chatId: string, level: PermissionLevel) => call<ChatView>('POST', `/api/chats/${encodeURIComponent(chatId)}/permission`, { level }),
  rename: (id: string, name: string) => call<AgentView>('POST', `/api/agents/${encodeURIComponent(id)}/name`, { name }),
  stop: (chatId: string) => call('POST', `/api/chats/${encodeURIComponent(chatId)}/stop`),
  clearError: (chatId: string) => call('POST', `/api/chats/${encodeURIComponent(chatId)}/clear-error`),
  pendingApprovals: () => call<Approval[]>('GET', '/api/approvals'),
  decide: (approvalId: string, allow: boolean, always = false) => call('POST', `/api/approvals/${approvalId}`, { allow, always }),
  /** Risposte a una domanda a scelte (testo della domanda → risposta); vuoto = saltate. */
  answer: (approvalId: string, answers: Record<string, string>) => call('POST', `/api/approvals/${approvalId}/answer`, { answers }),
  recap: () => call<{ recap: Recap | null; error: string | null }>('GET', '/api/recap'),
  usage: () => call<UsageState>('GET', '/api/usage'),
  /** Pacchetti (companion, app desktop) che il server ha da scaricare. */
  downloads: () => call<{ files: string[] }>('GET', '/api/downloads'),
  refreshRecap: () => call<{ recap: Recap }>('POST', '/api/recap/refresh'),
  statusMd: (id: string) => call<{ statusMd: string | null }>('GET', `/api/agents/${encodeURIComponent(id)}/status`),
  appSettings: () => call<AppSettings>('GET', '/api/settings'),
  updateAppSettings: (patch: Partial<AppSettings>) => call<{ settings: AppSettings; rejected: string[] }>('POST', '/api/settings', patch),
  passkeys: () => call<PasskeyView[]>('GET', '/api/auth/passkeys'),
  removePasskey: (id: string) => call('POST', '/api/auth/passkeys/remove', { id }),
  logoutAll: () => call('POST', '/api/auth/logout-all'),
  ciccio: (text: string, voice = false) => call<{ result: 'started' | 'queued' }>('POST', '/api/ciccio', { text, voice }),
  // Comandi con «/» di una chat (skill e comandi di Claude Code), per l'elenco nel campo di testo.
  commands: (agentId: string) => call<{ commands: SlashCommandView[] }>('GET', `/api/agents/${encodeURIComponent(agentId)}/commands`),
  ciccioCommands: () => call<{ commands: SlashCommandView[] }>('GET', '/api/ciccio/commands'),
  ciccioState: () => call<{ running: boolean; context: ContextInfo | null; suggestion: string | null }>('GET', '/api/ciccio/state'),
  ciccioStop: () => call('POST', '/api/ciccio/stop'),
  ciccioCompact: () => call('POST', '/api/ciccio/compact'),
  compactChat: (chatId: string) => call('POST', `/api/chats/${encodeURIComponent(chatId)}/compact`),
  newSession: (chatId: string) => call('POST', `/api/chats/${encodeURIComponent(chatId)}/new-session`),
  ciccioReset: () => call('POST', '/api/ciccio/reset'),
  routines: (agentId?: string) => call<RoutineView[]>('GET', `/api/routines${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
  routineRuns: (id: string) => call<{ runs: RoutineRun[] }>('GET', `/api/routines/${encodeURIComponent(id)}/runs`),
  createRoutine: (r: { agentId: string; name: string; text: string; cron: string; chatId: string | null; permission: PermissionLevel | null }) => call<RoutineView>('POST', '/api/routines', r),
  updateRoutine: (id: string, patch: { name?: string; text?: string; cron?: string; chatId?: string | null; enabled?: boolean; permission?: PermissionLevel | null }) => call<RoutineView>('POST', `/api/routines/${encodeURIComponent(id)}`, patch),
  runRoutine: (id: string) => call<{ result: 'started' | 'queued' | 'waiting' | 'skipped' }>('POST', `/api/routines/${encodeURIComponent(id)}/run`),
  removeRoutine: (id: string) => call('POST', `/api/routines/${encodeURIComponent(id)}/remove`),
};

/** Pacchetti che il server ha da scaricare (nomi dei file); null finché non risponde. */
export function useDownloads(): Set<string> | null {
  const [files, setFiles] = useState<Set<string> | null>(null);
  useEffect(() => { void api.downloads().then((r) => setFiles(new Set(r.files))).catch(() => setFiles(new Set())); }, []);
  return files;
}

/** Al posto del pulsante di un pacchetto che il server non ha. */
export const NO_PACKAGE = 'Il server non ha ancora questo pacchetto: vedi il README (Companion e app desktop) per prenderlo o compilarlo.';

/** Collegamento in tempo reale: collegato, mi ricollego, telefono offline, server che non risponde. */
export type ConnState = 'online' | 'connecting' | 'offline' | 'server';

/** Stato live di Ciccio: agenti con le loro chat, messaggi (per chat), permessi, fase e riepilogo. */
export function useCiccio() {
  const [agents, setAgents] = useState<Record<string, AgentView>>({});
  // Primo elenco arrivato: prima, «nessun progetto» vuol dire solo «non ancora caricati».
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [threads, setThreads] = useState<Record<string, ChatMessage[]>>({});
  const [approvals, setApprovals] = useState<Record<string, Approval>>({});
  const [phase, setPhase] = useState<CiccioPhase>('idle');
  const [recap, setRecap] = useState<Recap | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const reconnectRef = useRef<() => void>(() => undefined);
  const resyncRef = useRef<() => void>(() => undefined);
  const [recapError, setRecapError] = useState('');
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [usage, setUsage] = useState<UsageState | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [ciccioContext, setCiccioContext] = useState<ContextInfo | null>(null);
  const [ciccioSuggestion, setCiccioSuggestion] = useState<string | null>(null);
  // PC con il companion: servono anche per sapere se le notifiche arrivano già da lì.
  const [companions, setCompanions] = useState<CompanionView[]>([]);
  // App desktop collegate: se una è accesa, le notifiche le mostra lei.
  const [desktopApps, setDesktopApps] = useState<DesktopAppView[]>([]);
  const loaded = useRef(new Set<string>());
  const wsRef = useRef<WebSocket | null>(null);
  const viewingRef = useRef<string | null>(null);
  const onNotice = useRef<((m: ChatMessage) => void) | null>(null);

  const refresh = useCallback(async () => {
    const list = await api.agents();
    setAgents(Object.fromEntries(list.map((a) => [a.id, a])));
    setAgentsLoaded(true);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let failures = 0;
    let hiddenAt = 0;

    /**
     * Perché non si collega: dispositivo senza rete, oppure la rete c'è e Ciccio no. Si chiede solo a Ciccio, mai a
     * servizi di terzi: se tace e il dispositivo dice di avere rete, è il server (o Tailscale spento qui).
     */
    const diagnose = async (): Promise<ConnState> => {
      if (!navigator.onLine) return 'offline';
      try {
        const r = await fetch('/api/auth/state', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
        // Risponde Caddy ma non Ciccio (502/503/504): è il server.
        return r.ok ? 'connecting' : 'server';
      } catch {
        return navigator.onLine ? 'server' : 'offline';
      }
    };

    /** Al rientro: ricarica quello che è cambiato mentre il collegamento era giù. */
    const resync = () => {
      void refresh().catch(() => undefined);
      // Quelle non più in attesa sul server (giro fermato mentre eri via) spariscono anche qui.
      void api.pendingApprovals().then((list) => setApprovals((s) => {
        const live = new Set(list.map((a) => a.id));
        const next = { ...s };
        for (const [id, a] of Object.entries(next)) if (a.status === 'pending' && !live.has(id)) next[id] = { ...a, status: 'denied' };
        for (const a of list) next[a.id] = a;
        return next;
      })).catch(() => undefined);
      void api.ciccioState().then((r) => { setPhase(r.running ? 'thinking' : 'idle'); setCiccioContext(r.context); setCiccioSuggestion(r.suggestion ?? null); }).catch(() => undefined);
      for (const id of loaded.current) {
        void api.thread(id).then((t) => setThreads((s) => ({ ...s, [id]: t.messages }))).catch(() => undefined);
      }
    };

    const schedule = (ms: number) => {
      clearTimeout(retry);
      // In background non si insiste: si riprova appena torni sull'app.
      if (!closed && document.visibilityState === 'visible') retry = setTimeout(connect, ms);
    };

    const connect = () => {
      clearTimeout(retry);
      if (closed) return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws = sock;
      wsRef.current = sock;
      sock.onopen = () => {
        failures = 0;
        setConn('online');
        sock.send(JSON.stringify({ type: 'viewing', chatId: viewingRef.current }));
        resync();
        void api.companions().then(setCompanions).catch(() => undefined);
        void api.desktopApps().then(setDesktopApps).catch(() => undefined);
      };
      sock.onclose = () => {
        if (ws !== sock || closed) return;
        failures += 1;
        // I primi tentativi sono rapidi e silenziosi ("mi ricollego"); poi si capisce di chi è il problema.
        if (failures <= 2) { setConn('connecting'); schedule(failures === 1 ? 300 : 1000); return; }
        void diagnose().then((d) => { if (ws === sock) setConn(d); });
        schedule(Math.min(1000 * failures, 5000));
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data as string) as ServerEvent;
        if (ev.type === 'agent') setAgents((s) => ({ ...s, [ev.agent.id]: ev.agent }));
        if (ev.type === 'message' && ev.message.meta?.kind === 'notice') onNotice.current?.(ev.message);
        if (ev.type === 'message') {
          setThreads((s) => (loaded.current.has(ev.message.chatId)
            ? { ...s, [ev.message.chatId]: [...(s[ev.message.chatId] ?? []), ev.message] }
            : s));
        }
        if (ev.type === 'usage') setUsage(ev.state);
        if (ev.type === 'live') setLive((s) => ({ ...s, [ev.live.chatId]: ev.live }));
        if (ev.type === 'messageUpdate') {
          setThreads((s) => (s[ev.message.chatId]
            ? { ...s, [ev.message.chatId]: s[ev.message.chatId].map((m) => (m.id === ev.message.id ? ev.message : m)) }
            : s));
        }
        if (ev.type === 'approval') setApprovals((s) => ({ ...s, [ev.approval.id]: ev.approval }));
        if (ev.type === 'ciccio') setPhase(ev.phase);
        if (ev.type === 'recap') { setRecap(ev.recap); setRecapError(''); }
        if (ev.type === 'recapError') setRecapError(ev.error);
        if (ev.type === 'settings') { setTimeZone(ev.settings.timeZone); setSettings(ev.settings); }
        if (ev.type === 'ciccioContext') setCiccioContext(ev.context);
        if (ev.type === 'ciccioSuggestion') setCiccioSuggestion(ev.suggestion);
        // Le routine le leggono le loro sezioni (Impostazioni, pannello del progetto), non lo stato dell'app.
        if (ev.type === 'routines') window.dispatchEvent(new CustomEvent('ciccio:routines', { detail: ev.routines }));
        if (ev.type === 'desktopApps') setDesktopApps(ev.apps);
        if (ev.type === 'companions') { setCompanions(ev.companions); window.dispatchEvent(new CustomEvent('ciccio:companions', { detail: ev.companions })); }
      };
    };
    // Tornando sull'app, con la rete che torna o la finestra di nuovo in primo piano: subito.
    const wake = () => {
      if (closed || document.visibilityState !== 'visible') return;
      // Dopo un po' in background iOS lascia aperti collegamenti già morti: meglio rifarlo.
      if (ws && ws.readyState === WebSocket.OPEN && hiddenAt && Date.now() - hiddenAt > 15_000) {
        const old = ws;
        ws = null;
        old.close();
      }
      hiddenAt = 0;
      failures = 0;
      connect();
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') hiddenAt = Date.now(); else wake(); };
    const onOffline = () => setConn('offline');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', wake);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    reconnectRef.current = wake;
    // Trascina per aggiornare (telefono): ricollega se serve e ricarica agenti, permessi e chat aperte.
    resyncRef.current = () => { if (ws?.readyState === WebSocket.OPEN) resync(); else wake(); void loadRecap(false); };

    connect();
    void loadRecap(false);
    void api.usage().then(setUsage).catch(() => undefined);
    void api.appSettings().then((s) => { setTimeZone(s.timeZone); setSettings(s); }).catch(() => undefined);
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('focus', wake);
    };
  }, [refresh]);

  async function loadRecap(force: boolean) {
    setRecapError('');
    try {
      if (force) {
        setRecap(null);
        setRecap((await api.refreshRecap()).recap);
      } else {
        const r = await api.recap();
        setRecap(r.recap);
        setRecapError(r.error ?? '');
      }
    } catch (e) {
      setRecapError(e instanceof Error ? e.message : String(e));
    }
  }

  const openThread = useCallback(async (id: string) => {
    const t = await api.thread(id);
    loaded.current.add(id);
    setThreads((s) => ({ ...s, [id]: t.messages }));
    setApprovals((s) => {
      const next = { ...s };
      for (const a of t.approvals) next[a.id] = a;
      return next;
    });
  }, []);

  /** Dice al server quale chat hai sotto gli occhi: Ciccio non ti avvisa di quella. */
  const setViewing = useCallback((chatId: string | null) => {
    viewingRef.current = chatId;
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type: 'viewing', chatId }));
  }, []);

  /** Una chat appena creata entra subito nell'elenco, senza aspettare l'evento dal server. */
  const addChat = useCallback((chat: ChatView) => {
    setAgents((s) => {
      const a = s[chat.agentId];
      return a ? { ...s, [chat.agentId]: { ...a, chats: [chat, ...a.chats.filter((x) => x.id !== chat.id)] } } : s;
    });
  }, []);

  const decide = useCallback(async (id: string, allow: boolean, always = false) => {
    await api.decide(id, allow, always);
    setApprovals((s) => ({ ...s, [id]: { ...s[id], status: allow ? 'allowed' : 'denied' } }));
  }, []);

  const answer = useCallback(async (id: string, answers: Record<string, string>) => {
    try {
      await api.answer(id, answers);
    } catch (e) {
      // Già chiusa altrove (altra scheda, giro fermato): la finestra sparisce, niente errore.
      if (!/non più in attesa/.test(e instanceof Error ? e.message : '')) throw e;
    }
    setApprovals((s) => ({ ...s, [id]: { ...s[id], status: Object.keys(answers).length ? 'allowed' : 'denied' } }));
  }, []);

  return { agents, agentsLoaded, threads, approvals, phase, recap, recapError, loadRecap, online: conn === 'online', conn, reconnect: () => reconnectRef.current(), resync: () => resyncRef.current(), openThread, decide, answer, refresh, live, usage, addChat, setViewing, onNotice, settings, setSettings, ciccioContext, ciccioSuggestion, companions, desktopApps };
}

export function timeAgo(ms: number | null): string {
  if (!ms) return 'mai';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'ora';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} g`;
}
