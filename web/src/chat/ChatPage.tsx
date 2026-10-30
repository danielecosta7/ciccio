import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { collapse, pop } from '../motion';
import { api, timeAgo, fileBaseOf } from '../api';
import { Orb, PixelMark, PixelWordmark, STATUS, SettingsIcon, StatusPill } from '../ui';
import { Composer } from './Composer';
import { useAttachments } from './attachments';
import { useFileDrop } from './FileUpload';
import { useDraft } from '../drafts';
import { sentTexts } from '../sentHistory';
import { SidePane, type PaneTab } from './SidePane';
import { Transcript } from './Transcript';
import type { StickToBottomContext } from 'use-stick-to-bottom';
import { ChatContainerContent, ChatContainerRoot, ScrollButton, useBottomOnSend } from './ChatContainer';
import { ProjectNav, ChatTitleEdit } from './ProjectNav';
import { ContextMeter, ContextPanel, ContextWarning } from '../ContextMeter';
import { QuestionSlot, onlyPermissions } from '../QuestionPanel';
import { Sheet, SheetRow } from '../Sheet';
import { useBand } from '../viewport';
import { PermissionDock } from './PermissionDock';
import { useEdgeSwipeBack } from '../gestures';
import { outgoing } from '../listContinue';
import type { AgentInfo, AgentView, Approval, ChatMessage, ChatView, Effort, LiveState } from '../../../shared/types';

/**
 * Colonna laterale che si apre e chiude scorrendo di lato (subito, con «riduci movimento»).
 * Va con `relative` (a destra `xl:relative`: sotto xl è un cassetto fisso), così le etichette sr-only
 * restano dentro e a colonna chiusa la pagina non si allarga.
 */
const COLUMN = 'flex-none overflow-hidden transition-[width] duration-[280ms] ease-[cubic-bezier(.25,1,.5,1)] motion-reduce:transition-none';

/** Interruttore ricordato dal browser (localStorage), che resta spento se la memoria non c'è. */
function useStoredFlag(key: string) {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const set = useCallback((v: boolean) => {
    setOn(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* memoria del browser non disponibile */ }
  }, [key]);
  return [on, set] as const;
}

function PanelIcon({ side, on }: { side: 'left' | 'right'; on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d={side === 'left' ? 'M9 4v16' : 'M15 4v16'} />
      {on && <rect x={side === 'left' ? 3 : 15} y="4" width="6" height="16" rx="1" fill="currentColor" stroke="none" opacity=".35" />}
    </svg>
  );
}

/** Chat su un singolo progetto, con la struttura di Claude Code desktop. */
export function ChatPage(props: {
  agent: AgentView;
  chat: ChatView;
  agents: AgentView[];
  messages: ChatMessage[];
  live?: LiveState;
  approvals: Approval[];
  onDecide: (id: string, allow: boolean, always?: boolean) => void;
  /** Risposte a una domanda a scelte dell'agente. */
  onAnswer: (id: string, answers: Record<string, string>) => Promise<void>;
  onOpenChat: (agentId: string, chatId: string) => void;
  onNewChat: (agentId: string) => void;
  onBack: () => void;
  onSettings: () => void;
  onNewProject: () => void;
  /** Soglia (%) oltre cui la chat propone Comprimi o Nuova sessione. */
  contextWarn: number;
  ciccio: { running: boolean; unread: number; open: boolean; onToggle: () => void };
  /** Apre un file nel riquadro di anteprima sopra la chat; `onAsk` scrive una richiesta nel campo. */
  onPreview: (path: string, onAsk: (text: string) => void) => void;
}) {
  const { agent, chat } = props;
  const phone = useBand() === 'phone';
  const [editingTitle, setEditingTitle] = useState(false);
  // Telefono: il «⋯» della barra apre il menu della chat (contesto, nuova chat, rinomina, file, modifiche…).
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [info, setInfo] = useState<AgentInfo | null>(null);
  // Bozza della chat (testo e allegati): cambiando chat si ritrova, anche dopo un ricaricamento.
  const [draft, setDraft] = useDraft(`chat:${chat.id}`);
  const files = useAttachments(agent.id, `chat:${chat.id}`);
  const [tab, setTab] = useState<PaneTab>('chat');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState(false);
  // Schermo intero: le due colonne si nascondono e resta solo la conversazione (ricordato per browser).
  const [hideNav, setHideNav] = useStoredFlag('ciccio.chat.hideNav');
  const [hidePane, setHidePane] = useStoredFlag('ciccio.chat.hidePane');
  // Altezza dell'intestazione della chat, perché la barra delle schede a destra finisca alla stessa riga:
  // l'intestazione ha titolo e riga di stato e cambia altezza, quindi si misura invece di fissarla.
  const root = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLElement>(null);
  // Telefono, app installata: swipe dal bordo sinistro per tornare indietro.
  useEdgeSwipeBack(root, props.onBack, phone);
  useEffect(() => {
    const el = head.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => root.current?.style.setProperty('--cc-head', `${el.getBoundingClientRect().height}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc chiude il cassetto dei file, ma non se sopra c'è un'anteprima: lì chiude solo quella.
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"][aria-label^="Anteprima di"]')) setPaneOpen(false);
      // Ctrl/⌘+B: solo la conversazione, o di nuovo le due colonne.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        const focus = !(hideNav && hidePane);
        setHideNav(focus); setHidePane(focus);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hideNav, hidePane, setHideNav, setHidePane]);
  const [error, setError] = useState('');
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [diffKey, setDiffKey] = useState(0);
  const [, tick] = useState(0);

  const loadInfo = useCallback(() => { void api.info(agent.id, chat.id).then(setInfo).catch(() => undefined); }, [agent.id, chat.id]);
  useEffect(() => { setInfo(null); setSelectedFile(null); }, [agent.id]);
  useEffect(() => { setError(''); setEditingTitle(false); setMenuOpen(false); setRenaming(false); }, [chat.id]);
  useEffect(() => { loadInfo(); }, [loadInfo, agent.lastActivity]);

  // Durata del giro in corso; a fine giro si aggiornano le modifiche.
  useEffect(() => {
    if (chat.running) { setRunningSince((s) => s ?? Date.now()); const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }
    setRunningSince(null);
    setDiffKey((k) => k + 1);
    return undefined;
  }, [chat.running]);

  // Scorrimento: solo il riquadro della conversazione, e solo se si era già in fondo.
  const last = props.messages[props.messages.length - 1];
  const news = `${props.messages.length}:${last?.id}:${last?.meta?.kind === 'tool' ? String(last.meta.done) : ''}:${props.approvals.length}`;
  const scroller = useRef<StickToBottomContext>(null);
  // Mandando un messaggio si torna in fondo, anche se si stava leggendo più su.
  const toBottom = () => { void scroller.current?.scrollToBottom(); };
  useBottomOnSend(props.messages, scroller);

  const addFiles = files.add;
  // File trascinati in qualsiasi punto della pagina: allegati di questa chat.
  const dropOverlay = useFileDrop(root, { to: `a ${agent.name} · ${chat.title}`, onFiles: (f) => void addFiles(f), fallback: true });

  const send = async () => {
    const atts = files.ready;
    const text = outgoing(draft);
    if (!text && !atts.length) return;
    setDraft(''); files.clear(); setError('');
    toBottom();
    try { await api.send(chat.id, text, atts); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setDraft(text); }
  };

  const history = useMemo(() => sentTexts(props.messages), [props.messages]);
  const openFile = (p: string) => { setSelectedFile(p); props.onPreview(p, (t) => { setDraft(t); setPaneOpen(false); }); };
  const openPane = (t: PaneTab) => { setTab(t); setMenuOpen(false); setPaneOpen(true); };
  const permissionsWaiting = onlyPermissions(props.approvals).length > 0;

  return (
    <div ref={root} className="cc-safe-top cc-safe-x cc-viewport flex overflow-hidden bg-ink">
      {/* Telefono e tablet: progetti e chat in un cassetto da sinistra. */}
      <AnimatePresence>
        {navOpen && (
          <>
            <motion.div key="nav-veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setNavOpen(false)}
              className="fixed inset-0 z-40 bg-black/55 md:hidden" aria-hidden="true" />
            <motion.nav key="nav-drawer" aria-label="Progetti e chat" initial={{ x: '-100%' }} animate={{ x: 0, transition: { duration: 0.28, ease: [0.25, 1, 0.5, 1] } }} exit={{ x: '-100%', transition: { duration: 0.18 } }}
              className="cc-safe-top cc-safe-bottom fixed inset-y-0 left-0 z-50 flex w-[min(320px,86vw)] flex-col border-r border-line bg-[oklch(0.145_0_0)] md:hidden">
              <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
                <span className="flex items-center gap-2">
                  <span className="pixel-16">Progetti</span>
                  <button type="button" onClick={() => { setNavOpen(false); props.onSettings(); }} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-muted">Impostazioni</button>
                </span>
                <button type="button" onClick={() => setNavOpen(false)} aria-label="Chiudi l'elenco" className="cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border border-line text-muted">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              </div>
              <ProjectNav agents={props.agents} currentAgentId={agent.id} currentChatId={chat.id}
                onOpenChat={(a, c) => { setNavOpen(false); props.onOpenChat(a, c); }}
                onNewChat={(a) => { setNavOpen(false); props.onNewChat(a); }}
                onNewProject={() => { setNavOpen(false); props.onNewProject(); }} />
            </motion.nav>
          </>
        )}
      </AnimatePresence>
      <div inert={hideNav} className={`${COLUMN} relative hidden md:flex ${hideNav ? 'w-0' : 'w-[272px]'}`}>
      <nav aria-label="Agenti" className="flex w-[272px] flex-none flex-col border-r border-line/70 bg-[oklch(0.145_0_0)]">
        <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
          <button type="button" onClick={props.onBack} className="flex items-center gap-2.5" aria-label="Torna alla dashboard">
            <PixelMark size={32} />
            <PixelWordmark />
          </button>
          <span className="flex items-center gap-1.5">
            <button type="button" onClick={props.onSettings} aria-label="Impostazioni" title="Impostazioni" className="flex h-7 w-7 items-center justify-center rounded-full border border-line text-muted hover:text-text">
              <SettingsIcon size={14} />
            </button>
            <button type="button" onClick={props.onBack} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-muted hover:text-text">Dashboard</button>
          </span>
        </div>
        <ProjectNav agents={props.agents} currentAgentId={agent.id} currentChatId={chat.id} onOpenChat={props.onOpenChat} onNewChat={props.onNewChat} onNewProject={props.onNewProject} />
      </nav>
      </div>

      <main className="relative flex min-w-0 flex-1 flex-col">
        {phone ? (
        <header ref={head} className="flex h-[52px] flex-none items-center gap-0.5 border-b border-line/70 px-1">
          <button type="button" onClick={props.onBack} aria-label="Indietro" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-soft">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <button type="button" onClick={() => setMenuOpen(true)} aria-label={`${chat.title}: menu della chat`} className="flex min-w-0 flex-1 flex-col justify-center text-left">
            <span className="truncate text-[16px] font-semibold leading-tight">{chat.title}</span>
            <span className="cc-hide-kb flex min-w-0 items-center gap-1.5 text-[12px] leading-tight text-muted">
              <span className={`h-[7px] w-[7px] flex-none ${chat.status === 'wait' ? 'cc-sq-pulse' : ''}`} style={{ background: STATUS[chat.status].color }} />
              <span className="truncate">{agent.name} · {STATUS[chat.status].label.toLowerCase()}</span>
            </span>
          </button>
          <button type="button" onClick={props.ciccio.onToggle} aria-pressed={props.ciccio.open}
            aria-label={`Chat con Ciccio${props.ciccio.unread ? `, ${props.ciccio.unread} risposte nuove` : ''}`}
            className="cc-press relative flex h-11 w-11 flex-none items-center justify-center rounded-[10px]">
            {props.ciccio.running ? <Orb state="solving" size={20} label="Ciccio sta lavorando" /> : <PixelMark size={16} />}
            <AnimatePresence>
              {props.ciccio.unread > 0 && (
                <motion.span key="n" {...pop} className="absolute top-1 right-0.5 flex h-[17px] min-w-[17px] items-center justify-center bg-acid px-1 font-mono text-[10.5px] font-semibold text-ink">{props.ciccio.unread}</motion.span>
              )}
            </AnimatePresence>
          </button>
          <button type="button" onClick={() => setMenuOpen(true)} aria-label="Menu della chat" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-soft">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
          </button>
        </header>
        ) : (
        <header ref={head} className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button type="button" onClick={() => setHideNav(!hideNav)} aria-pressed={!hideNav} aria-label="Progetti e chat"
              title={`${hideNav ? 'Mostra' : 'Nascondi'} progetti e chat (Ctrl/⌘+B: solo la conversazione)`}
              className={`cc-press hidden h-9 w-9 flex-none items-center justify-center rounded-[8px] border md:flex ${hideNav ? 'border-line text-muted hover:text-text' : 'border-line-hi text-soft hover:text-text'}`}>
              <PanelIcon side="left" on={!hideNav} />
            </button>
            <button type="button" onClick={props.onBack} aria-label="Torna alla dashboard" title="Torna alla dashboard"
              className="cc-press flex h-9 flex-none items-center gap-1.5 rounded-[8px] border border-line px-2.5 text-[13px] text-soft hover:text-text">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6" /></svg>
              <span className="hidden lg:inline xl:hidden 2xl:inline">Dashboard</span>
            </button>
            <button type="button" onClick={() => setNavOpen(true)} aria-label="Progetti e chat" title="Progetti e chat"
              className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] border border-line text-soft hover:text-text md:hidden">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
            </button>
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted">
                <span className="truncate">{agent.name}</span><span aria-hidden="true">›</span>
              </div>
              {editingTitle ? (
                <ChatTitleEdit chat={chat} className="text-[17px] font-semibold" onDone={() => setEditingTitle(false)} />
              ) : (
                <button type="button" onClick={() => setEditingTitle(true)} title="Rinomina la chat" className="group flex min-w-0 items-center gap-2 text-left">
                  <span className="truncate text-[17px] font-semibold">{chat.title}</span>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none text-muted opacity-0 transition-opacity group-hover:opacity-100"><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg>
                </button>
              )}
              {/* Una riga sola: con le due colonne aperte il branch si accorcia invece di andare a capo. */}
              <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted">
                <span className="flex-none"><StatusPill status={chat.status} /></span>
                {/* Sotto i 1024 px non c'è spazio per il branch: si vede da lì in su. */}
                {info?.branch && <span className="hidden min-w-0 truncate rounded-[6px] border border-line px-1.5 py-0.5 font-mono text-soft lg:block">⎇ {info.branch}</span>}
                <span className="flex-none">
                <ContextMeter align="left" context={chat.context} warn={props.contextWarn} onCompact={() => void api.compactChat(chat.id)} onNewSession={() => void api.newSession(chat.id)} /></span>
              </div>
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <button type="button" onClick={props.ciccio.onToggle} aria-pressed={props.ciccio.open} title="Chat con Ciccio (⌘K)"
              aria-label={`Chat con Ciccio${props.ciccio.unread ? `, ${props.ciccio.unread} risposte nuove` : ''}`}
              className={`cc-press relative flex min-h-9 items-center gap-2 rounded-[8px] border px-2 text-[13px] ${props.ciccio.open ? 'border-acid/60 text-text' : 'border-line text-soft'}`}>
              <span className="flex h-5 w-5 items-center justify-center">{props.ciccio.running ? <Orb state="solving" size={20} label="Ciccio sta lavorando" /> : <PixelMark size={16} />}</span>
              <span className="hidden lg:inline xl:hidden 2xl:inline">Ciccio</span>
              <AnimatePresence>
                {props.ciccio.unread > 0 && (
                  <motion.span key="n" {...pop} className="flex h-[18px] min-w-[18px] items-center justify-center bg-acid px-1 font-mono text-[10.5px] font-semibold text-ink">{props.ciccio.unread}</motion.span>
                )}
              </AnimatePresence>
            </button>
            <button type="button" onClick={() => props.onNewChat(agent.id)} title="Nuova chat in questo progetto"
              className="cc-press flex min-h-9 items-center gap-1.5 rounded-[8px] border border-line px-2.5 text-[13px] text-soft hover:text-text">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span className="hidden lg:inline xl:hidden 2xl:inline">Nuova chat</span>
            </button>
            <AnimatePresence initial={false}>
            {chat.status === 'block' && (
              <motion.button key="unblock" {...pop} type="button" onClick={() => void api.clearError(chat.id)} className="cc-press min-h-9 rounded-[8px] border border-line px-3 text-[13px] text-soft">Sblocca</motion.button>
            )}
            </AnimatePresence>
            <button type="button" onClick={() => setPaneOpen((o) => !o)} aria-pressed={paneOpen} aria-label="Dettagli della chat" title="Dettagli della chat"
              className="cc-press flex min-h-9 min-w-9 items-center justify-center gap-1.5 rounded-[8px] border border-line px-2 text-[13px] text-soft lg:px-3 xl:hidden">
              <span className="lg:hidden"><PanelIcon side="right" on={paneOpen} /></span>
              <span className="hidden lg:inline">Dettagli della chat</span>
            </button>
            <button type="button" onClick={() => setHidePane(!hidePane)} aria-pressed={!hidePane} aria-label="Dettagli della chat"
              title={`${hidePane ? 'Mostra' : 'Nascondi'} file e impostazioni (Ctrl/⌘+B: solo la conversazione)`}
              className={`cc-press hidden h-9 w-9 flex-none items-center justify-center rounded-[8px] border xl:flex ${hidePane ? 'border-line text-muted hover:text-text' : 'border-line-hi text-soft hover:text-text'}`}>
              <PanelIcon side="right" on={!hidePane} />
            </button>
          </div>
        </header>
        )}

        <ChatContainerRoot key={chat.id} contextRef={scroller} className="relative min-h-0 flex-1">
          <ChatContainerContent scrollClassName="cc-scroll overscroll-contain">
          <Transcript
            messages={props.messages}
            approvals={props.approvals}
            agentName={agent.name}
            running={chat.running}
            fileBase={fileBaseOf(agent.id, chat.id)}
            live={props.live}
            runningSince={runningSince}
            onDecide={props.onDecide}
            onOpenFile={openFile}
            dockPermissions={phone}
          />
          </ChatContainerContent>
          <ScrollButton signal={news} className="bottom-4" />
        </ChatContainerRoot>
        <AnimatePresence initial={false}>
        {error && <motion.div key="error" {...collapse} className="mx-auto w-full max-w-[880px] overflow-hidden px-6 text-[13px] text-block"><div className="pb-1">{error}</div></motion.div>}
        </AnimatePresence>
        <ContextWarning context={chat.context} warn={props.contextWarn} running={chat.running} onCompact={() => void api.compactChat(chat.id)} onNewSession={() => void api.newSession(chat.id)} />
        {/* Domanda dell'agente: sopra il campo di testo, come nell'app di Claude. */}
        <QuestionSlot approvals={props.approvals} from={agent.name} onAnswer={props.onAnswer} className="mx-auto w-full max-w-[880px] px-4 pb-2 sm:px-6" />
        {phone && <PermissionDock approvals={props.approvals} onDecide={props.onDecide} className="flex-none px-3 pb-2" />}
        <Composer
          agentName={agent.name}
          chat={chat}
          draft={draft}
          setDraft={setDraft}
          files={files.files}
          onAddFiles={(f) => void addFiles(f)}
          onRemoveFile={files.remove}
          onOpenFile={openFile}
          onSend={() => void send()}
          onVoice={(t) => { toBottom(); return api.send(chat.id, t).then(() => undefined); }}
          onModel={(model: string, effort: Effort) => void api.settings(chat.id, model, effort)}
          history={history}
          phone={phone}
          pending={phone && permissionsWaiting}
        />
        {dropOverlay}
      </main>

      {/* Telefono: foglio dal basso a tutta altezza. Sotto xl è un cassetto da destra; da xl in su una colonna fissa, che si può nascondere. */}
      {phone ? (
        <Sheet open={paneOpen} onClose={() => setPaneOpen(false)} label="Dettagli della chat" size="full" bodyClassName="flex flex-col px-0">
          <SidePane agent={agent} chat={chat} info={info} messages={props.messages} contextWarn={props.contextWarn} tab={tab} setTab={setTab} selectedFile={selectedFile}
            onOpenFile={openFile} onInfoChanged={loadInfo} onCompact={() => void api.compactChat(chat.id)} onNewSession={() => void api.newSession(chat.id)} diffKey={diffKey} compact />
        </Sheet>
      ) : (
      <div inert={hidePane && !paneOpen}
        className={`${paneOpen ? 'cc-drawer cc-safe-top cc-safe-bottom fixed inset-y-0 right-0 z-30 flex w-[min(420px,100vw)] shadow-[0_0_8px_rgb(0_0_0/.5)]' : 'hidden'} ${COLUMN} border-l border-line/70 xl:relative xl:z-auto xl:flex xl:shadow-none ${hidePane ? 'xl:w-0 xl:border-l-0' : 'xl:w-[400px]'}`}>
        <div className="flex min-w-0 flex-1 flex-col xl:w-[400px] xl:flex-none">
          <SidePane
            agent={agent}
            chat={chat}
            info={info}
            messages={props.messages}
            contextWarn={props.contextWarn}
            onCompact={() => void api.compactChat(chat.id)}
            onNewSession={() => void api.newSession(chat.id)}
            tab={tab}
            setTab={setTab}
            selectedFile={selectedFile}
            onOpenFile={openFile}
            onInfoChanged={loadInfo}
            diffKey={diffKey}
            onClose={paneOpen ? () => setPaneOpen(false) : undefined}
          />
        </div>
      </div>
      )}

      {/* Menu della chat sul telefono: quello che sul computer sta nella barra e nel pannello di destra. */}
      {phone && (
        <Sheet open={menuOpen} onClose={() => { setMenuOpen(false); setRenaming(false); }} label="Menu della chat"
          title={chat.title} sub={<>{agent.name}{info?.branch ? ` · ⎇ ${info.branch}` : ''}</>}>
          <div className="flex flex-col gap-3">
            <ContextPanel context={chat.context} warn={props.contextWarn}
              onCompact={() => { setMenuOpen(false); void api.compactChat(chat.id); }} onNewSession={() => { setMenuOpen(false); void api.newSession(chat.id); }} />
            {renaming && <ChatTitleEdit chat={chat} className="min-h-11 text-[16px]" onDone={() => setRenaming(false)} />}
            <div className="flex flex-col">
              {chat.status === 'block' && <SheetRow label="Sblocca la chat" tone="block" chevron={false} onClick={() => { setMenuOpen(false); void api.clearError(chat.id); }} />}
              <SheetRow label="Nuova chat" onClick={() => { setMenuOpen(false); props.onNewChat(agent.id); }} />
              <SheetRow label="Rinomina" chevron={false} onClick={() => setRenaming(true)} />
              <SheetRow label="Ambiente e output" onClick={() => openPane('chat')} />
              <SheetRow label="Modifiche" onClick={() => openPane('diff')} />
              <SheetRow label="STATUS.md" onClick={() => openPane('status')} />
              <SheetRow label="Impostazioni del progetto" onClick={() => openPane('settings')} />
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
