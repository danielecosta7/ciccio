import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { api, timeAgo, useCiccio } from './api';
import { AgentPanel } from './AgentPanel';
import { ChatPage } from './chat/ChatPage';
import { FileModal, type PreviewFile } from './chat/FileViewer';
import { CiccioBubble, CiccioDock } from './CiccioDock';
import { CiccioBoxChat } from './CiccioBoxChat';
import { byWork } from './order';
import { collapse, page as pageMotion, pop, quick, rise, smooth } from './motion';
import { SettingsPage } from './SettingsPage';
import { SetupPage, useSetup } from './Setup';
import { Sparkles } from './Sparkles';
import { NewProjectDialog } from './NewProject';
import { CONN, ConnBanner } from './ConnBanner';
import { MicIcon, Orb, PHASE_ORB, PixelMark, PixelWordmark, SendIcon, SettingsIcon, STATUS, StatusPill, TONE_COLOR, ClaudeUsage, AlwaysLabel, ApprovalDetail, alwaysOnly, alwaysRule, runRing, toolLabel, type VoicePhase } from './ui';
import { configureSpeaker, setVoicePrefs, useConversation } from './voice/hooks';
import { ConversationOverlay } from './voice/ConversationOverlay';
import { Speaker } from './voice/speaker';
import { ASK_TOOL, CICCIO_THREAD, type AgentStatus, type AgentView, type Approval } from '../../shared/types';
import { dayIn, timeZone } from '../../shared/tz';
import { healViewport, useBand, useKeyboard } from './viewport';
import { PullIndicator, TAB_PATH, TabBar, type Tab } from './TabBar';
import { usePullToRefresh } from './gestures';
import { ProjectNav } from './chat/ProjectNav';

type Filter = 'all' | AgentStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Tutti' },
  { key: 'wait', label: 'Ti aspettano' },
  { key: 'block', label: 'Bloccati' },
  { key: 'work', label: 'Al lavoro' },
  { key: 'stale', label: 'Fermi' },
  { key: 'idle', label: 'In ordine' },
];

function todayLabel() {
  return new Intl.DateTimeFormat('it-IT', { timeZone: timeZone(), weekday: 'short', day: 'numeric', month: 'long' }).format(new Date());
}

export function App() {
  const c = useCiccio();
  const [filter, setFilter] = useState<Filter>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [selChat, setSelChat] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [askError, setAskError] = useState('');

  const band = useBand();
  const phone = band === 'phone';
  const keyboard = useKeyboard();
  const [path, setPath] = useState(location.pathname);
  // Direzione dell'ultimo passaggio di pagina (1 avanti, -1 indietro, 0 cambio di scheda): la usa la transizione.
  const [dir, setDir] = useState(0);
  // Posizione nella cronologia dell'app: «indietro» torna alla pagina di prima solo se c'è, altrimenti alla dashboard.
  const histIndex = useRef(0);
  // Indietro con lo swipe dal bordo: la chat è già fuori schermo, quindi niente animazione d'uscita (motion.ts, page).
  const swiped = useRef(false);
  useEffect(() => {
    const on = () => { swiped.current = true; };
    window.addEventListener('ciccio:swiped-back', on);
    return () => window.removeEventListener('ciccio:swiped-back', on);
  }, []);
  useEffect(() => {
    const i = (history.state as { i?: number } | null)?.i;
    if (typeof i === 'number') histIndex.current = i; else history.replaceState({ i: 0 }, '');
    const onPop = () => {
      const next = (history.state as { i?: number } | null)?.i ?? 0;
      setDir(swiped.current ? -2 : next < histIndex.current ? -1 : 1);
      swiped.current = false;
      histIndex.current = next;
      setPath(location.pathname);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // "/impostazioni#progetti": la parte dopo # porta alla sezione, il resto è la pagina.
  const go = (p: string, d = p.startsWith('/agente/') ? 1 : 0) => {
    const [page, hash] = p.split('#');
    histIndex.current += 1;
    history.pushState({ i: histIndex.current }, '', p);
    setDir(d);
    setPath(page);
    window.scrollTo(0, 0);
    if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
  };
  // Cambio di pagina: se iOS ha lasciato lo schermo più basso dopo la tastiera, è il momento di farlo rimisurare.
  useEffect(() => { const t = setTimeout(healViewport, 400); return () => clearTimeout(t); }, [path]);
  const replace = (p: string) => { history.replaceState({ i: histIndex.current }, '', p); setPath(p); };
  const back = () => {
    if (histIndex.current > 0) { history.back(); return; }
    setDir(swiped.current ? -2 : -1);
    swiped.current = false;
    replace('/');
  };
  // /agente/<progetto>/<chat>: senza chat si apre la più recente.
  const [focusId, focusChatParam] = path.startsWith('/agente/')
    ? path.slice('/agente/'.length).split('/').map((x) => decodeURIComponent(x)) as [string, string | undefined]
    : [null, undefined];
  const chatUrl = (agentId: string, chatId: string) => `/agente/${encodeURIComponent(agentId)}/${encodeURIComponent(chatId)}`;
  const focusAgent = focusId ? c.agents[focusId] : undefined;
  const focusChat = focusAgent ? (focusChatParam ? focusAgent.chats.find((x) => x.id === focusChatParam) : focusAgent.chats[0]) : undefined;

  const newChat = useCallback(async (agentId: string) => {
    const chat = await api.createChat(agentId);
    c.addChat(chat);
    return chat;
  }, [c.addChat]);

  // Progetto senza chat, o chat archiviata: si va alla più recente, o se ne apre una nuova.
  const creating = useRef(false);
  useEffect(() => {
    if (!focusAgent || focusChat || creating.current) return;
    if (focusAgent.chats[0]) { replace(chatUrl(focusAgent.id, focusAgent.chats[0].id)); return; }
    creating.current = true;
    void newChat(focusAgent.id).then((chat) => replace(chatUrl(chat.agentId, chat.id))).finally(() => { creating.current = false; });
  }, [focusAgent, focusChat, newChat]);

  useEffect(() => { void c.openThread(CICCIO_THREAD); }, [c.openThread]);

  // Configurazione: al primo accesso di questa sessione, se manca qualcosa di obbligatorio, si apre da sola.
  const setup = useSetup();
  const setupMissing = setup.report?.mancano ?? 0;
  useEffect(() => {
    if (!setupMissing || location.pathname !== '/') return;
    try {
      if (sessionStorage.getItem('ciccio.setupShown')) return;
      sessionStorage.setItem('ciccio.setupShown', '1');
    } catch { /* memoria non disponibile: si apre comunque una volta */ }
    go('/configurazione');
  }, [setupMissing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Tornando su Impostazioni o Configurazione si rilegge (il server tiene il risultato 30 secondi).
  const reloadSetup = setup.reload;
  useEffect(() => { if (path === '/impostazioni' || path === '/configurazione') void reloadSetup(); }, [path, reloadSetup]);
  useEffect(() => { if (focusChat?.id) void c.openThread(focusChat.id); }, [focusChat?.id, c.openThread]);
  const selectedAgent = sel ? c.agents[sel] : undefined;
  const panelChat = selectedAgent ? selectedAgent.chats.find((x) => x.id === selChat) ?? selectedAgent.chats[0] : undefined;
  useEffect(() => { if (panelChat?.id) void c.openThread(panelChat.id); }, [panelChat?.id, c.openThread]);

  // Chat che hai davanti (pagina o pannello), solo se la scheda è visibile.
  const viewingId = focusChat?.id ?? panelChat?.id ?? null;
  useEffect(() => {
    const update = () => c.setViewing(document.visibilityState === 'visible' ? viewingId : null);
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [viewingId, c.setViewing]);

  // Avvisi di Ciccio come notifiche del computer, se le hai permesse e non stai guardando Ciccio.
  useEffect(() => {
    c.onNotice.current = (m) => {
      // Se un PC con Ciccio Companion mostra già le notifiche native, quella del browser sarebbe doppia.
      if (c.companions.some((x) => x.online && x.notifications)) return;
      // Lo stesso con l'app desktop accesa: le mostra lei, con i pulsanti per i permessi.
      if (c.desktopApps.some((x) => x.online)) return;
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (document.visibilityState === 'visible' && dockOpenRef.current) return;
      const meta = m.meta?.kind === 'notice' ? m.meta : null;
      const n = new Notification(meta ? `Ciccio · ${c.agents[meta.agentId]?.name ?? meta.agentId}` : 'Ciccio', { body: m.text, tag: `ciccio-${m.id}`, icon: '/favicon.svg' });
      n.onclick = () => { window.focus(); if (matchMedia('(max-width: 639.98px)').matches) go('/ciccio'); else setDockOpen(true); n.close(); };
    };
  });

  // Chat con Ciccio: aperta o ridotta, ricordato tra una visita e l'altra.
  const [dockOpen, setDockOpenState] = useState(() => { try { return localStorage.getItem('ciccio.dock') === '1'; } catch { return false; } });
  // Telefono: Ciccio è la scheda /ciccio, o un foglio sopra la chat di un agente.
  const chatViewEarly = path.startsWith('/agente/');
  const ciccioVisible = phone ? path === '/ciccio' || (chatViewEarly && dockOpen) : dockOpen;
  const dockOpenRef = useRef(ciccioVisible);
  dockOpenRef.current = ciccioVisible;
  const setDockOpen = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setDockOpenState((o) => {
      const next = typeof v === 'function' ? v(o) : v;
      try { localStorage.setItem('ciccio.dock', next ? '1' : '0'); } catch { /* memoria del browser non disponibile */ }
      return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setDockOpen((o) => !o); }
      // Esc chiude il pannello dell'agente se non stai scrivendo in un campo,
      // e non se c'è un'anteprima aperta sopra (lì chiude solo l'anteprima: bozza e allegati restano).
      const preview = document.querySelector('[role="dialog"][aria-label^="Anteprima di"]');
      if (e.key === 'Escape' && !preview && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { setSel(null); setSelChat(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setDockOpen]);


  async function ask(text: string) {
    const t = text.trim();
    if (!t) return;
    setDraft('');
    setBusy(true);
    setAskError('');
    if (!phone) setDockOpen(true);
    try {
      await api.ciccio(t);
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const ciccioThread = c.threads[CICCIO_THREAD] ?? [];
  const ciccioRunning = c.phase !== 'idle';

  // Conversazione a voce: microfono, Whisper e Piper sul server, a mani libere.
  const [convOpen, setConvOpen] = useState(false);
  const [newProject, setNewProject] = useState<'new' | 'github' | null>(null);
  useEffect(() => {
    setVoicePrefs({ sensitivity: c.settings?.micSensitivity, stt: c.settings?.sttEngine, tts: c.settings?.ttsEngine, speed: c.settings?.voiceSpeed });
  }, [c.settings]);
  const conv = useConversation({
    thread: ciccioThread, live: c.live[CICCIO_THREAD], running: ciccioRunning, replies: c.settings?.voiceReplies,
    sensitivity: c.settings?.micSensitivity, stt: c.settings?.sttEngine, tts: c.settings?.ttsEngine, speed: c.settings?.voiceSpeed,
  });
  const openConversation = () => { setConvOpen(true); void conv.start(); };
  const closeConversation = () => { conv.stop(); setConvOpen(false); };
  // Riepilogo letto dalla stessa voce di Ciccio.
  const recapSpeaker = useRef<Speaker | null>(null);
  const [recapSpeaking, setRecapSpeaking] = useState(false);
  // Telefono: il riepilogo si apre da solo alla prima visita del giorno, poi resta ridotto (titolo e «Leggi tutto»).
  const [recapOpen, setRecapOpen] = useState(() => {
    const day = dayIn();
    try { if (localStorage.getItem('ciccio.recapSeen') === day) return false; localStorage.setItem('ciccio.recapSeen', day); } catch { /* memoria non disponibile */ }
    return true;
  });
  const speakRecap = () => {
    if (!c.recap) return;
    recapSpeaker.current ??= new Speaker();
    const sp = recapSpeaker.current;
    configureSpeaker(sp, { tts: c.settings?.ttsEngine, speed: c.settings?.voiceSpeed });
    if (sp.busy) { sp.stop(); return; }
    sp.unlock();
    sp.onState = setRecapSpeaking;
    // A voce solo l'essenziale: il titolo e le due cose più urgenti (chi aspetta te, chi è bloccato); il resto è scritto.
    const order = ['wait', 'block', 'work', 'done', 'stale', 'info'];
    const top = [...c.recap.lines].sort((x, y) => order.indexOf(x.tone) - order.indexOf(y.tone)).slice(0, 2);
    const more = c.recap.lines.length - top.length;
    sp.say([c.recap.headline, ...top.map((l) => l.text), more === 1 ? 'Un\'altra cosa è scritta nel riepilogo.' : more > 1 ? `Altre ${more} cose sono scritte nel riepilogo.` : ''].filter(Boolean).join('\n'));
  };

  // Risposte arrivate a chat ridotta.
  const [seenId, setSeenId] = useState(() => { try { return Number(localStorage.getItem('ciccio.seen') ?? 0); } catch { return 0; } });
  const lastCiccioId = ciccioThread[ciccioThread.length - 1]?.id ?? 0;
  useEffect(() => {
    if (!ciccioVisible || lastCiccioId <= seenId) return;
    setSeenId(lastCiccioId);
    try { localStorage.setItem('ciccio.seen', String(lastCiccioId)); } catch { /* memoria del browser non disponibile */ }
  }, [ciccioVisible, lastCiccioId, seenId]);
  // Una domanda di Ciccio in attesa conta come una risposta da leggere.
  const ciccioAsks = Object.values(c.approvals).filter((x) => x.chatId === CICCIO_THREAD && x.status === 'pending' && x.tool === ASK_TOOL).length;
  const unread = ciccioVisible ? 0 : ciccioThread.filter((m) => m.id > seenId && (m.role === 'agent' || m.role === 'ciccio')).length + ciccioAsks;

  // In ordine di lavorazione, come nella colonna dei progetti (web/src/order.ts).
  // I progetti nascosti (Impostazioni › Progetti) non compaiono in dashboard né nei conteggi.
  const list = useMemo(() => Object.values(c.agents).filter((a) => !a.hidden).sort(byWork), [c.agents]);
  const hiddenCount = useMemo(() => Object.values(c.agents).filter((a) => a.hidden).length, [c.agents]);
  const counts = useMemo(() => {
    const n: Record<Filter, number> = { all: list.length, wait: 0, block: 0, work: 0, stale: 0, idle: 0 };
    for (const a of list) n[a.status] += 1;
    return n;
  }, [list]);
  const shown = filter === 'all' ? list : list.filter((a) => a.status === filter);
  const running = list.filter((a) => a.running).length;
  const selected = sel ? c.agents[sel] : null;
  const pendingOf = (agentId: string) => Object.values(c.approvals).filter((x) => x.agentId === agentId && x.status === 'pending').sort((x, y) => x.ts - y.ts);
  /** La chat di un progetto che serve aprire: quella con un permesso o una domanda, poi chi aspetta, è bloccata o lavora. */
  const urgentChat = (a: AgentView): string | undefined => {
    const p = pendingOf(a.id)[0];
    if (p) return p.chatId;
    const rank: Record<AgentStatus, number> = { wait: 0, block: 1, work: 2, stale: 3, idle: 4 };
    return [...a.chats].sort((x, y) => rank[x.status] - rank[y.status])[0]?.id;
  };
  const waitingAgents = list.filter((a) => a.status === 'wait' || pendingOf(a.id).length > 0);
  // Pagine del telefono con la barra in basso.
  const tab: Tab | null = !phone ? null : path === '/' ? 'agenti' : path === '/chat' ? 'chat' : path === '/ciccio' ? 'ciccio' : path === '/impostazioni' || path === '/configurazione' ? 'impostazioni' : null;
  const showTabs = tab != null && !keyboard;
  const pull = usePullToRefresh(c.resync, phone && (path === '/' || path === '/chat'));
  // Scheda Chat e pagina di Ciccio esistono solo sul telefono: altrove si torna alla dashboard (Ciccio nel riquadro).
  useEffect(() => {
    if (phone) return;
    if (path === '/ciccio') { replace('/'); setDockOpen(true); } else if (path === '/chat') replace('/');
  }, [phone, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const vp: VoicePhase = conv.state === 'listening' || conv.state === 'hearing' ? 'listening' : conv.state === 'speaking' || recapSpeaking ? 'speaking' : c.phase !== 'idle' ? c.phase : busy ? 'thinking' : 'idle';

  const PHASE_TEXT: Record<VoicePhase, [string, string]> = {
    idle: ['Parla con Ciccio', 'Parla come al telefono: ti ascolta, risponde a voce e aspetta la tua prossima frase. Per esempio «come siamo messi?»'],
    listening: ['Ti ascolto…', conv.interim || 'Parla pure, capisco da solo quando hai finito.'],
    thinking: ['Ci penso…', 'Controllo agenti, chat e connettori, poi ti rispondo nella chat.'],
    connecting: ['Sento gli agenti…', 'Passo il messaggio all’agente giusto.'],
    speaking: ['Ti rispondo', 'Sto leggendo la risposta ad alta voce.'],
  };

  const pendingFor = (chatId: string) => Object.values(c.approvals).filter((x) => x.chatId === chatId && x.status === 'pending');

  const chatView = !!focusAgent;
  const [fileModal, setFileModal] = useState<PreviewFile | null>(null);
  /** File nominato da Ciccio: progetto e percorso. Null se è la cartella di un progetto (o non si sa di chi è). */
  const ciccioFile = (p: string): { agentId: string; path: string } | null => {
    // I file di Ciccio sono relativi alla cartella dei progetti (o assoluti): il pezzo che è un progetto dice il repo, il resto è il file.
    const parts = p.split('/').filter(Boolean);
    const i = parts.findIndex((s) => c.agents[s]);
    // Fuori dai progetti (es. ~/anteprime): il server lo trova dal percorso, basta un progetto qualsiasi per chiederlo.
    if (i < 0) { const any = Object.keys(c.agents)[0]; return any && (p.startsWith('/') || p.startsWith('~/')) ? { agentId: any, path: p } : null; }
    const rest = parts.slice(i + 1).join('/');
    return rest ? { agentId: parts[i], path: rest } : null;
  };
  const openPathFromCiccio = (p: string) => {
    const f = ciccioFile(p);
    if (f) { setFileModal(f); return; }
    const project = p.split('/').filter(Boolean).find((s) => c.agents[s]);
    if (project) go(`/agente/${encodeURIComponent(project)}`);
  };
  const ciccioFileUrl = (p: string) => { const f = ciccioFile(p); return f ? api.fileUrl(f.agentId, f.path) : null; };

  // Chat con Ciccio: riquadro flottante (tablet, desktop), foglio sopra una chat o scheda a pagina intera (telefono).
  const dockProps = {
    onClose: () => setDockOpen(false),
    messages: ciccioThread,
    live: c.live[CICCIO_THREAD],
    approvals: pendingFor(CICCIO_THREAD),
    running: ciccioRunning,
    phase: vp,
    onTalk: openConversation,
    context: c.ciccioContext,
    suggestion: c.ciccioSuggestion,
    contextWarn: c.settings?.contextWarn ?? 80,
    onSend: (t: string) => void ask(t),
    onDecide: (id: string, allow: boolean, always?: boolean) => void c.decide(id, allow, always),
    onAnswer: c.answer,
    onOpenFile: openPathFromCiccio,
    fileUrl: ciccioFileUrl,
    onOpenChat: (agentId: string, chatId: string) => go(chatUrl(agentId, chatId)),
    shifted: !chatView && !!selected,
  };
  const settingsView = path === '/impostazioni';
  const setupView = path === '/configurazione';
  const page = settingsView ? (
      <SettingsPage settings={c.settings} onSettings={c.setSettings} agents={Object.values(c.agents)} usage={c.usage} onBack={phone ? undefined : () => go('/')} onNewProject={setNewProject} companions={c.companions} desktopApps={c.desktopApps} onOpenChat={(agentId, chatId) => go(chatUrl(agentId, chatId))} setup={setup} />
  ) : setupView ? (
      <SetupPage setup={setup} onBack={phone ? undefined : back} onGo={(section) => go(`/impostazioni#${section}`)} />
  ) : path === '/chat' && phone ? renderChatList() : path === '/ciccio' && phone ? renderCiccioPage() : focusAgent ? (focusChat ? (
      <ChatPage
        agent={focusAgent}
        chat={focusChat}
        agents={Object.values(c.agents)}
        messages={c.threads[focusChat.id] ?? []}
        live={c.live[focusChat.id]}
        approvals={pendingFor(focusChat.id)}
        onDecide={(id, allow, always) => void c.decide(id, allow, always)}
        onAnswer={c.answer}
        onOpenChat={(agentId, chatId) => go(chatUrl(agentId, chatId))}
        onSettings={() => go('/impostazioni')}
        onNewProject={() => setNewProject('new')}
        contextWarn={c.settings?.contextWarn ?? 80}
        onNewChat={(agentId) => void newChat(agentId).then((chat) => go(chatUrl(agentId, chat.id)))}
        onBack={phone ? back : () => go('/')}
        ciccio={{ running: ciccioRunning, unread, open: ciccioVisible, onToggle: () => setDockOpen((o) => !o) }}
        onPreview={(p, onAsk) => setFileModal({ agentId: focusAgent.id, chatId: focusChat?.id, path: p, onAsk })}
      />
  ) : <div className="flex h-dvh items-center justify-center"><Orb state="connecting" size={32} label="Apro la chat" /></div>) : renderDashboard();

  return (
    <>
      <AnimatePresence mode="wait" initial={false} custom={dir}>
        {phone ? (
          <motion.div key={settingsView ? 'settings' : setupView ? 'setup' : chatView ? 'chat' : path} custom={dir} variants={pageMotion} initial="initial" animate="animate" exit="exit">
            {page}
          </motion.div>
        ) : (
          <motion.div key={settingsView ? 'settings' : setupView ? 'setup' : chatView ? 'chat' : 'dashboard'}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: smooth }} exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}>
            {page}
          </motion.div>
        )}
      </AnimatePresence>
      {showTabs && <TabBar active={tab} onGo={(t) => (t === tab ? window.scrollTo({ top: 0, behavior: 'smooth' }) : go(TAB_PATH[t], 0))} waiting={waitingAgents.length} unread={unread} ciccioRunning={ciccioRunning} />}
      {phone && <PullIndicator pull={pull.pull} busy={pull.busy} />}
      {!(phone && path === '/ciccio') && <CiccioDock {...dockProps} open={phone ? chatView && dockOpen : dockOpen} variant={phone ? 'sheet' : 'float'} />}
      <ConnBanner conn={c.conn} onRetry={c.reconnect} />
      <FileModal file={fileModal} onClose={() => setFileModal(null)} onOpen={(p) => setFileModal((f) => (f ? { ...f, path: p } : f))} />
      <NewProjectDialog open={!!newProject} mode={newProject ?? 'new'} onClose={() => setNewProject(null)}
        onCreated={(agentId, chatId) => { void c.refresh().then(() => go(chatUrl(agentId, chatId))); }} />
      <ConversationOverlay open={convOpen} state={conv.state} interim={conv.interim} said={conv.said} reply={conv.reply} level={conv.level}
        muted={conv.muted} error={conv.error} silent={conv.silent} live={c.live[CICCIO_THREAD]} onMute={conv.toggleMute} onClose={closeConversation} />
      <CiccioBubble visible={!phone && !dockOpen && !chatView && !settingsView && !setupView && !convOpen} unread={unread} running={ciccioRunning} onOpen={() => setDockOpen(true)} shifted={!!selected} />
    </>
  );

  function renderChatList() {
    return (
      <div className="cc-safe-top cc-safe-x min-h-dvh" style={{ paddingBottom: 'calc(var(--cc-tabbar) + 24px)' }}>
        <header className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
          <h1 className="pixel-16 m-0">Chat</h1>
          <button type="button" onClick={() => setNewProject('new')}
            className="cc-press inline-flex min-h-11 items-center gap-1.5 rounded-[12px] border border-acid/60 px-3.5 text-[14px] font-medium text-acid">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            Progetto
          </button>
        </header>
        <ProjectNav page agents={Object.values(c.agents)} currentAgentId={null} currentChatId={null}
          onOpenChat={(agentId, chatId) => go(chatUrl(agentId, chatId))}
          onNewChat={(agentId) => void newChat(agentId).then((chat) => go(chatUrl(agentId, chat.id)))}
          onNewProject={() => setNewProject('new')} />
        <p className="m-0 mx-4 mt-4 text-[12.5px] leading-snug text-muted">Scorri una chat verso sinistra per rinominarla o archiviarla. Archiviare non cancella i messaggi.</p>
      </div>
    );
  }

  function renderCiccioPage() {
    return (
      <div className="cc-safe-top cc-safe-x cc-viewport flex flex-col" style={{ paddingBottom: keyboard ? 0 : 'var(--cc-tabbar)' }}>
        <CiccioDock {...dockProps} open variant="page" />
      </div>
    );
  }

  function renderDashboard() {

  const recapIsToday = c.recap?.day === dayIn();
  const recapAt = `${String(c.settings?.recapHour ?? 5).padStart(2, '0')}:00`;
  const noProjects = c.agentsLoaded && Object.keys(c.agents).length === 0;
  // Telefono, «Tutti»: chi ti aspetta sta in cima, e sotto non si ripete.
  const waitingFirst = phone && filter === 'all' && waitingAgents.length > 0;
  const cards = waitingFirst ? shown.filter((a) => !waitingAgents.includes(a)) : shown;
  const card = (a: AgentView, i: number) => (
    <AgentCard key={a.id} a={a} index={i} selected={a.id === sel} compact={phone}
      pending={pendingOf(a.id)}
      onDecide={(id, allow, always) => void c.decide(id, allow, always)}
      onOpen={(chatId) => {
        // Telefono: si va dritti alla chat che serve. Altrove si apre il pannello, sulla chat che serve.
        const target = chatId ?? urgentChat(a);
        if (phone) go(target ? chatUrl(a.id, target) : `/agente/${encodeURIComponent(a.id)}`);
        else { setSel(a.id); setSelChat(target ?? null); }
      }} />
  );

  return (
    <div className="cc-safe-top cc-safe-x min-h-dvh">
      {/* Spazio in fondo: l'ultima riga di card non finisce mai sotto la bolla di Ciccio (o la barra in basso). */}
      <div className={`mx-auto flex max-w-[1400px] flex-col px-4 sm:px-8 ${phone ? 'gap-4 pt-1' : 'gap-5 pt-6 pb-28'}`}
        style={phone ? { paddingBottom: 'calc(var(--cc-tabbar) + 28px)' } : undefined}>
        {phone ? (
        <header className="flex items-center gap-2">
          <PixelMark size={32} />
          <h1 className="m-0 flex h-6 flex-1 items-center"><PixelWordmark scale={2} /></h1>
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-line" title={CONN[c.conn].label} role="img" aria-label={CONN[c.conn].label}>
            <span className={c.conn === 'online' || c.conn === 'connecting' ? 'cc-sq-pulse' : ''} style={{ width: 8, height: 8, background: CONN[c.conn].color }} />
          </span>
          <ClaudeUsage compact state={c.usage} />
          {setupMissing > 0 && (
            <button type="button" onClick={() => go('/configurazione')} aria-label={`Configurazione: ${setupMissing} da fare`} title="Configurazione"
              className="cc-press flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-[12px] border border-wait/60 px-2.5 font-mono text-[13px] font-medium text-wait">
              <span className="h-2 w-2 bg-wait" aria-hidden="true" />{setupMissing}
            </button>
          )}
          <button type="button" onClick={() => setNewProject('new')} aria-label="Nuovo progetto"
            className="cc-press flex h-11 w-11 items-center justify-center rounded-[12px] border border-acid/60 text-acid">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </header>
        ) : (
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <PixelMark />
            <h1 className="m-0 flex h-6 items-center"><PixelWordmark scale={3} /></h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-soft" title={CONN[c.conn].label}>
              <span className={c.conn === 'online' || c.conn === 'connecting' ? 'cc-sq-pulse' : ''} style={{ width: 7, height: 7, background: CONN[c.conn].color }} />
              <span className={c.online ? 'hidden sm:inline' : ''}>{CONN[c.conn].label}</span>
            </span>
            <ClaudeUsage state={c.usage} />
            <button type="button" onClick={() => go('/impostazioni')} aria-label="Impostazioni" title="Impostazioni"
              className="cc-press inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-muted hover:text-text">
              <SettingsIcon />
              <span className="hidden sm:inline">Impostazioni</span>
            </button>
            {setupMissing > 0 && (
              <button type="button" onClick={() => go('/configurazione')} title="Cose da sistemare sul server"
                className="cc-press inline-flex items-center gap-2 rounded-full border border-wait/60 px-3 py-1.5 text-[13px] text-wait">
                <span className="h-[7px] w-[7px] bg-wait" aria-hidden="true" />Configurazione · <span className="font-mono text-[12px] font-medium">{setupMissing}</span>
              </button>
            )}
            <span className="hidden items-center gap-2 rounded-full border border-line px-3 py-1.5 text-muted sm:inline-flex">
              Sessioni attive <span className="font-mono text-[12px] font-medium text-acid">{running}</span>
            </span>
          </div>
        </header>
        )}

        {waitingFirst && (
          <section aria-label="Ti aspettano" className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 font-mono text-[11.5px] font-medium tracking-wide text-wait uppercase">
              <span className="h-2 w-2 bg-wait" />Ti aspettano · {waitingAgents.length}
            </div>
            <div className="flex flex-col gap-2.5">
              <AnimatePresence mode="popLayout" initial={false}>{waitingAgents.map(card)}</AnimatePresence>
            </div>
          </section>
        )}

        <section className="flex flex-wrap items-stretch gap-4">
          {phone && !recapOpen ? (
          <div className="cc-in cc-dots relative isolate flex min-w-0 flex-1 flex-col gap-2 rounded-[14px] border border-line bg-panel p-4">
            <div className="flex items-center gap-2 font-mono text-[11px] font-medium tracking-wide text-muted uppercase">
              <span aria-hidden="true" style={{ width: 8, height: 8, background: '#A6FF00' }} />
              Riepilogo · {c.recap && !recapIsToday ? `del ${c.recap.day.split('-').reverse().join('/')}` : todayLabel()}
            </div>
            <div className="flex items-start gap-3">
              <h2 className="cc-selectable m-0 min-w-0 flex-1 text-[17px] font-semibold leading-snug tracking-[-0.01em]">
                {c.recap ? c.recap.headline : c.recapError ? `Riepilogo non disponibile: ${c.recapError}` : noProjects ? 'Il riepilogo parte quando hai un progetto.' : `Il riepilogo arriva ogni mattina alle ${recapAt}.`}
              </h2>
              <button type="button" disabled={!c.recap} onClick={speakRecap} aria-label={recapSpeaking ? 'Ferma la lettura' : 'Ascolta il riepilogo'}
                className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-full bg-acid text-ink disabled:opacity-50">
                {recapSpeaking ? <span className="h-3 w-3 bg-ink" /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>}
              </button>
            </div>
            {c.recap && c.recap.lines.length > 0 && (
              <button type="button" onClick={() => setRecapOpen(true)} className="-mb-1 self-start py-1.5 text-[13.5px] font-medium text-muted">
                Leggi tutto <span aria-hidden="true">›</span>
              </button>
            )}
          </div>
          ) : (
          <div className="cc-in cc-dots relative isolate flex min-w-0 flex-[999_1_560px] flex-col gap-4 rounded-[14px] border border-line bg-panel p-6 sm:p-7">
            <Sparkles />
            <div className="pixel-16 flex items-center gap-3 text-muted">
              <span aria-hidden="true" style={{ width: 10, height: 10, background: '#A6FF00' }} />
              Riepilogo · {c.recap && !recapIsToday ? `del ${c.recap.day.split('-').reverse().join('/')}` : todayLabel()}
            </div>
            {c.recap ? (
              <>
                <h2 className="cc-in cc-selectable m-0 max-w-[32ch] text-[28px] font-semibold leading-tight tracking-[-0.03em] sm:text-[32px]">{c.recap.headline}</h2>
                <ul className="cc-selectable m-0 flex list-none flex-col gap-3 p-0 text-[15px] leading-relaxed text-soft">
                  {c.recap.lines.map((l, i) => (
                    <li key={i} className="cc-in flex items-baseline gap-3" style={{ animationDelay: `${40 + i * 40}ms` }}>
                      <span className="flex-none" style={{ width: 8, height: 8, background: TONE_COLOR[l.tone] }} />
                      <span>{l.text}</span>
                    </li>
                  ))}
                </ul>
                {!recapIsToday && c.recapError && <div className="cc-in text-[13.5px] text-block">Quello di oggi non è riuscito: {c.recapError}</div>}
              </>
            ) : c.recapError ? (
              <div className="cc-in text-[15px] text-block">Riepilogo non disponibile: {c.recapError}</div>
            ) : noProjects ? (
              <div className="cc-in text-[15px] text-muted">Ciccio prepara il riepilogo ogni mattina alle {recapAt}, appena c'è almeno un progetto.</div>
            ) : (
              <div className="cc-in flex items-center gap-3 text-[15px] text-muted"><Orb state="solving" size={20} /> Ciccio prepara il riepilogo ogni mattina alle {recapAt}. Il primo arriva a breve.</div>
            )}
            <div className="flex flex-wrap gap-2.5 pt-1">
              <button type="button" disabled={!c.recap} onClick={speakRecap}
                className="cc-press inline-flex min-h-11 items-center gap-2.5 rounded-full bg-acid px-5 text-[15px] font-semibold text-ink disabled:opacity-50">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" /></svg>
                {recapSpeaking ? 'Ferma la lettura' : 'Ascolta il riepilogo'}
              </button>
              <button type="button" onClick={() => setFilter('wait')} className="cc-press inline-flex min-h-11 items-center rounded-full border border-line-hi px-5 text-[15px] font-medium">Mostra chi ti aspetta</button>
              <button type="button" onClick={() => void c.loadRecap(true)} className="cc-press inline-flex min-h-11 items-center rounded-full px-4 text-[14px] text-muted hover:text-text">Aggiorna</button>
              {phone && <button type="button" onClick={() => setRecapOpen(false)} className="cc-press inline-flex min-h-11 items-center rounded-full px-4 text-[14px] text-muted">Riduci</button>}
            </div>
          </div>
          )}

          {/* Box di Ciccio: stato, voce e chat in alto, risposta e campo di testo dentro il box. Sul telefono Ciccio ha la sua scheda. */}
          {!phone && <div className="cc-in flex min-w-0 flex-[1_1_340px] flex-col gap-3.5 rounded-[14px] border border-line bg-panel p-5" style={{ animationDelay: '120ms' }}>
            <div className="flex items-center gap-3.5">
              <div className="flex h-[80px] w-[80px] flex-none items-center justify-center rounded-[12px] border border-line bg-ink"><Orb state={PHASE_ORB[vp]} size={64} label={`Ciccio: ${PHASE_TEXT[vp][0]}`} /></div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <PixelWordmark />
                <span className={`text-[14px] ${vp === 'idle' ? 'text-muted' : 'text-acid'}`}>{vp === 'idle' ? 'Pronto' : PHASE_TEXT[vp][0]}</span>
              </div>
              <button type="button" onClick={openConversation} aria-label="Parla con Ciccio" title="Parla con Ciccio"
                className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-full bg-acid text-ink"><MicIcon /></button>
              <button type="button" onClick={() => setDockOpen(true)} aria-label="Apri la chat con Ciccio" title="Apri la chat (⌘K)"
                className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-full border border-line-hi text-soft hover:text-text">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1.1-4.6A8 8 0 1121 12z" /></svg>
              </button>
            </div>
            <CiccioBoxChat
              messages={ciccioThread}
              approvals={pendingFor(CICCIO_THREAD)}
              running={ciccioRunning}
              live={c.live[CICCIO_THREAD]}
              onDecide={(id, allow, always) => void c.decide(id, allow, always)}
              onOpenFile={openPathFromCiccio}
              fileUrl={ciccioFileUrl}
              onOpenChat={(agentId, chatId) => go(chatUrl(agentId, chatId))}
            />
            <AnimatePresence initial={false}>
            {askError && <motion.div key="error" {...collapse} className="overflow-hidden text-[13px] text-block">{askError}</motion.div>}
            </AnimatePresence>
            <form onSubmit={(e) => { e.preventDefault(); void ask(draft); }} className="mt-auto flex items-center gap-2">
              <label className="flex min-h-11 min-w-0 flex-1 items-center rounded-full border border-line bg-ink px-4 focus-within:border-acid/60">
                <span className="sr-only">Scrivi a Ciccio</span>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Scrivi a Ciccio…" autoComplete="off" data-1p-ignore
                  className="min-w-0 flex-1 bg-transparent text-[14px] text-text outline-none placeholder:text-muted" />
              </label>
              <button type="submit" aria-label="Invia a Ciccio" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-full bg-acid text-ink"><SendIcon /></button>
            </form>
          </div>}
        </section>

        <div className={phone ? 'cc-hscroll -mx-4 px-4' : 'flex flex-wrap items-center justify-between gap-3'}>
          <div role="group" aria-label="Filtra gli agenti" className={phone ? 'flex w-max gap-2' : 'flex flex-wrap gap-2'}>
            {!phone && <button type="button" onClick={() => setNewProject('new')}
              className="cc-press inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-acid/60 px-3.5 text-[14px] font-medium text-acid hover:bg-acid/[.06]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              Nuovo progetto
            </button>}
            {FILTERS.map((f) => {
              const on = filter === f.key;
              return (
                <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={on}
                  className={`relative inline-flex min-h-11 flex-none items-center gap-2 rounded-full border px-3.5 text-[14px] font-medium transition-colors duration-200 ${on ? 'border-acid text-ink' : 'border-line text-text hover:border-line-hi'}`}>
                  {/* Il verde scivola sul filtro scelto. */}
                  {on && <motion.span layoutId="filter-pill" className="absolute inset-0 rounded-full bg-acid" transition={smooth} />}
                  <span className="relative">{f.label}</span><span className={`relative font-mono text-[12px] ${on ? 'text-ink' : 'text-muted'}`}>{counts[f.key]}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Il pannello è fisso sopra la pagina: aprirlo non deve spostare le card. */}
        <div className="flex flex-wrap items-start gap-4">
          <div className={`grid min-w-0 flex-[999_1_560px] grid-cols-[repeat(auto-fill,minmax(250px,1fr))] ${phone ? 'gap-2.5' : 'gap-3'}`}>
            <AnimatePresence mode="popLayout" initial={false}>
              {cards.map(card)}
            </AnimatePresence>
            <AnimatePresence initial={false}>
            {shown.length === 0 && c.agentsLoaded && !noProjects && <motion.div key="none" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: smooth }} exit={{ opacity: 0, transition: quick }} className="col-span-full py-10 text-center text-muted">Nessun agente in questo stato.</motion.div>}
            {/* Primo avvio: nessun progetto ancora. */}
            {noProjects && c.online && (
              <motion.div key="first" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: smooth }} exit={{ opacity: 0, transition: quick }}
                className="col-span-full flex flex-col gap-3 rounded-[14px] border border-dashed border-acid/50 bg-panel p-5 text-[14px] leading-relaxed text-soft sm:p-6">
                <h2 className="m-0 text-[17px] font-semibold text-text">Ancora nessun progetto</h2>
                <p className="m-0">Ogni progetto è un repo git nella cartella dei progetti del server (<code className="font-mono text-[13px]">CICCIO_PROJECTS_DIR</code>, di serie <code className="font-mono text-[13px]">~/projects</code>) e ha il suo agente. Per cominciare:</p>
                <ul className="m-0 flex flex-col gap-1.5 pl-5">
                  <li>clona i tuoi repo in quella cartella: compaiono qui da soli entro qualche minuto;</li>
                  <li>oppure usa «Nuovo progetto» o «Da GitHub»: Ciccio crea o clona il repo per te. Serve GitHub CLI collegato sul server (<code className="font-mono text-[13px]">gh auth login</code>, come l'utente di Ciccio).</li>
                </ul>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" onClick={() => setNewProject('new')} className="cc-press min-h-11 rounded-full bg-acid px-5 text-[14px] font-semibold text-ink">Nuovo progetto</button>
                  <button type="button" onClick={() => setNewProject('github')} className="cc-press min-h-11 rounded-full border border-line-hi px-5 text-[14px] font-medium">Da GitHub</button>
                  <button type="button" onClick={() => void api.syncProjects().then(() => c.refresh())} className="cc-press min-h-11 rounded-full px-4 text-[14px] text-muted hover:text-text">Ricontrolla la cartella</button>
                </div>
              </motion.div>
            )}
            </AnimatePresence>
            {hiddenCount > 0 && (
              <button type="button" onClick={() => go('/impostazioni#progetti')} className="cc-in col-span-full justify-self-center rounded-full px-3 py-1.5 text-[12.5px] text-muted hover:text-text">
                {hiddenCount === 1 ? '1 progetto nascosto' : `${hiddenCount} progetti nascosti`} · gestisci
              </button>
            )}
          </div>
          {/* Tablet: velo sotto il pannello, che copre metà delle card; un tocco fuori lo chiude. */}
          <AnimatePresence>
          {selected && band === 'tablet' && (
            <motion.div key="veil" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: smooth }} exit={{ opacity: 0, transition: quick }}
              onClick={() => { setSel(null); setSelChat(null); }} className="fixed inset-0 z-20 bg-black/40" />
          )}
          </AnimatePresence>
          <AnimatePresence>
          {selected && (
            <AgentPanel
              key={selected.id}
              agent={selected}
              chat={panelChat}
              messages={panelChat ? c.threads[panelChat.id] ?? [] : []}
              approvals={panelChat ? pendingFor(panelChat.id) : []}
              onDecide={(id, allow, always) => void c.decide(id, allow, always)}
              onAnswer={c.answer}
              onClose={() => { setSel(null); setSelChat(null); }}
              onSelectChat={setSelChat}
              onNewChat={async () => { const chat = await newChat(selected.id); setSelChat(chat.id); return chat; }}
              onExpand={() => go(panelChat ? chatUrl(selected.id, panelChat.id) : `/agente/${encodeURIComponent(selected.id)}`)}
              onOpenFile={(p) => setFileModal({ agentId: selected.id, chatId: panelChat?.id, path: p })}
            />
          )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
  }
}

function AgentCard({ a, index, selected, pending, onDecide, onOpen, compact = false }: {
  a: AgentView; index: number; selected: boolean; pending: Approval[];
  onDecide: (id: string, allow: boolean, always?: boolean) => void; onOpen: (chatId?: string) => void;
  /** Telefono: card più bassa, una riga di testo in meno, pulsanti dei permessi da 44 px. */
  compact?: boolean;
}) {
  // In attesa dell'utente: contorno arancio in movimento che lampeggia; al lavoro: verde in movimento; ferma: il bordo di sempre.
  const border = runRing(pending.length ? 'wait' : a.status)
    || (selected ? 'border-acid' : a.status === 'block' ? 'border-block/45' : 'border-line');
  const first = pending[0];
  const chatTitle = first ? a.chats.find((c) => c.id === first.chatId)?.title : undefined;
  // Domanda a scelte: si risponde dal pannello, nella sua chat (la finestra sopra il campo di testo).
  const asks = first?.tool === ASK_TOOL;
  const perms = pending.filter((x) => x.tool !== ASK_TOOL).length;
  return (
    // La card apre il pannello; i pulsanti dei permessi dentro no (si approva senza aprire niente).
    <motion.div role="button" tabIndex={0} onClick={() => onOpen()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      aria-label={`Apri l'agente ${a.name}`}
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { ...smooth, delay: Math.min(index * 0.012, 0.18) } }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14 } }}
      transition={smooth}
      className={`cc-card flex cursor-pointer flex-col gap-2.5 rounded-[12px] border p-4 text-left ${compact ? '' : 'min-h-[136px]'} ${selected ? 'bg-panel-hi' : 'bg-panel'} ${border}`}>
      <div className="flex w-full items-start justify-between gap-2.5">
        <span className="flex min-w-0 flex-col">
          <span className="break-all text-[15px] font-semibold">{a.name}</span>
          {a.name !== a.id && <span className="break-all font-mono text-[11px] text-muted">{a.id}</span>}
          {a.name === a.id && <span className="sr-only">repo {a.id}</span>}
        </span>
        <StatusPill status={first ? 'wait' : a.status} />
      </div>
      <AnimatePresence initial={false} mode="popLayout">
        {first && asks ? (
          <motion.div key={first.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: smooth }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}
            onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
            className="cc-glow flex cursor-default flex-col gap-2 rounded-[10px] border border-wait/45 bg-wait/[.06] p-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="cc-wrap text-[12.5px] font-semibold leading-snug text-wait">Ti fa una domanda</span>
              {chatTitle && a.chats.length > 1 && <span className="cc-wrap text-[11.5px] text-muted">{chatTitle}</span>}
            </div>
            <span className="cc-wrap line-clamp-3 text-[13.5px] leading-snug text-text">{first.summary.replace(/^Domanda: /, '')}</span>
            <button type="button" onClick={() => onOpen(first.chatId)} className={`cc-press rounded-[8px] bg-acid px-3 font-semibold text-ink ${compact ? 'min-h-11 text-[14px]' : 'min-h-9 text-[13px]'}`}>Rispondi</button>
            {pending.length > 1 && <span className="text-[12px] text-muted">+ altri {pending.length - 1} in attesa</span>}
          </motion.div>
        ) : first ? (
          <motion.div key={first.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: smooth }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.14 } }}
            onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
            className="cc-glow flex cursor-default flex-col gap-2 rounded-[10px] border border-wait/45 bg-wait/[.06] p-2.5">
            <div className="flex flex-col gap-0.5">
              <span className="cc-wrap text-[12.5px] font-semibold leading-snug text-wait">{toolLabel(first.tool)}</span>
              {chatTitle && a.chats.length > 1 && <span className="cc-wrap text-[11.5px] text-muted">{chatTitle}</span>}
            </div>
            {/* Intero, scorre se è lungo: nessuna riga del comando resta nascosta. */}
            <ApprovalDetail a={first} small />
            <div className={`grid gap-1.5 ${alwaysRule(first) ? 'grid-cols-3' : 'grid-cols-2'}`}>
              {/* Una proposta di strumento si salva solo con «Consenti sempre». */}
              <button type="button" onClick={() => onDecide(first.id, true, alwaysOnly(first.tool))} className={`cc-press rounded-[8px] bg-acid px-1 font-semibold text-ink ${compact ? 'min-h-11 text-[14px]' : 'min-h-9 text-[13px]'}`}>{alwaysOnly(first.tool) ? 'Sempre' : 'Consenti'}</button>
              {alwaysRule(first) && (
              <button type="button" onClick={() => onDecide(first.id, true, true)} className={`cc-press min-w-0 rounded-[8px] border border-line-hi px-1 ${compact ? 'min-h-11 text-[14px]' : 'min-h-9 text-[13px]'}`}><AlwaysLabel rule={alwaysRule(first)!} /></button>
              )}
              <button type="button" onClick={() => onDecide(first.id, false)} className={`cc-press rounded-[8px] border border-line-hi px-1 ${compact ? 'min-h-11 text-[14px]' : 'min-h-9 text-[13px]'}`}>Rifiuta</button>
            </div>
            {pending.length > 1 && <span className="text-[12px] text-muted">+ altri {pending.length - 1} in attesa</span>}
          </motion.div>
        ) : (
          <motion.div key="line" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14 } }} className={`${compact ? 'line-clamp-2' : 'line-clamp-3'} text-[14px] leading-relaxed text-soft`}>{a.line}</motion.div>
        )}
      </AnimatePresence>
      <div className="mt-auto flex w-full items-center justify-between gap-2 font-mono text-[12px] text-muted">
        <span>{a.lastReply ? `risposta ${timeAgo(a.lastReply)}` : `commit ${timeAgo(a.lastActivity)}`}{perms ? ` · ${perms} permessi` : ''}{pending.length > perms ? ' · domanda' : ''}</span>
        <AnimatePresence initial={false}>
        {a.status === 'wait' && !first && <motion.span key="reply" {...pop} className="font-sans text-[13px] font-semibold" style={{ color: STATUS.wait.color }}>Rispondi →</motion.span>}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
