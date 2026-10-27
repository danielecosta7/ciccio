import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDictation } from './voice/hooks';
import { ContextMeter, ContextPanel, ContextWarning } from './ContextMeter';
import { listEnter, listIndent } from './listContinue';
import { autoGrow } from './autoGrow';
import { sentTexts, useSentHistory } from './sentHistory';
import { usePromptSuggestion } from './promptSuggestion';
import { CICCIO_COMMANDS, useSlashCommands } from './slashCommands';
import { useDraft } from './drafts';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { Sheet, SheetRow } from './Sheet';
import { api } from './api';
import { MicIcon, Orb, PixelMark, PixelWordmark, PHASE_ORB, type VoicePhase } from './ui';
import { Transcript } from './chat/Transcript';
import type { StickToBottomContext } from 'use-stick-to-bottom';
import { ChatContainerContent, ChatContainerRoot, ScrollButton, useBottomOnSend } from './chat/ChatContainer';
import { QuestionSlot } from './QuestionPanel';
import { useFileDrop } from './chat/FileUpload';
import { collapse, pop, quick, rise, sheetIn, sheetOut } from './motion';
import { CICCIO_THREAD, type ContextInfo, type Approval, type ChatMessage, type LiveState } from '../../shared/types';


const SUGGESTIONS = ['Come siamo messi?', 'Chi mi sta aspettando?', 'Cosa ho in calendario oggi?', 'Ci sono email importanti?'];

const PHASE_LABEL: Record<VoicePhase, string> = {
  idle: 'Pronto',
  listening: 'Ti ascolto…',
  thinking: 'Ci penso…',
  connecting: 'Sento gli agenti…',
  speaking: 'Ti rispondo a voce',
};

/** Chat con Ciccio sempre a portata di mano: pannello che sale dal basso, sopra qualsiasi pagina. */
export function CiccioDock(props: {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  live?: LiveState;
  approvals: Approval[];
  running: boolean;
  phase: VoicePhase;
  /** Apre la conversazione a voce a tutto schermo. */
  onTalk: () => void;
  context: ContextInfo | null;
  contextWarn: number;
  /** Prossimo messaggio suggerito da Ciccio a fine giro. */
  suggestion: string | null;
  onSend: (text: string) => void;
  onDecide: (id: string, allow: boolean, always?: boolean) => void;
  /** Risposte a una domanda a scelte di Ciccio. */
  onAnswer: (id: string, answers: Record<string, string>) => Promise<void>;
  onOpenFile: (path: string) => void;
  /** Indirizzo di un file nominato da Ciccio, per Copia e Scarica. */
  fileUrl: (path: string) => string | null;
  onOpenChat: (agentId: string, chatId: string) => void;
  /** Spazio da lasciare a destra (pannello di un agente aperto). */
  shifted?: boolean;
  /**
   * «float» riquadro flottante (tablet e desktop); sul telefono «page» è la scheda Ciccio a pagina intera,
   * «sheet» un foglio dal basso sopra la chat di un agente.
   */
  variant?: 'float' | 'page' | 'sheet';
}) {
  const variant = props.variant ?? 'float';
  const phoneUi = variant !== 'float';
  const isSheet = variant === 'sheet';
  const drag = useDragControls();
  const [moreOpen, setMoreOpen] = useState(false);
  // Bozza: resta chiudendo il pannello e anche dopo un ricaricamento.
  const [draft, setDraft] = useDraft('ciccio');
  // Dettatura con Whisper sul server: la frase finita si aggiunge al testo.
  const dict = useDictation(useCallback((t: string) => setDraft((d) => (d ? `${d} ${t}` : t)), [setDraft]));
  const area = useRef<HTMLTextAreaElement>(null);
  const history = useMemo(() => sentTexts(props.messages), [props.messages]);
  const recall = useSentHistory(history, draft, setDraft);
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const hint = usePromptSuggestion({ suggestion: props.running ? null : props.suggestion, value: draft, setValue: setDraft, area, touch, off: dict.listening });
  const slash = useSlashCommands({ source: CICCIO_COMMANDS, value: draft, setValue: setDraft, area, off: dict.listening || recall.browsing });
  const [since, setSince] = useState<number | null>(null);
  const [, tick] = useState(0);
  const last = props.messages[props.messages.length - 1];
  const news = `${props.messages.length}:${last?.id}:${props.approvals.length}`;
  const scroller = useRef<StickToBottomContext>(null);
  // Mandando un messaggio si torna in fondo, anche se si stava leggendo più su.
  const toBottom = () => { void scroller.current?.scrollToBottom(); };
  useBottomOnSend(props.messages, scroller);
  // Ciccio non riceve allegati: trascinandoli qui il riquadro lo dice (e il browser non apre il file al posto della pagina).
  const dock = useRef<HTMLElement>(null);
  const dropOverlay = useFileDrop(dock, { to: 'Trascinali nella chat di un agente', refuse: 'Ciccio non riceve allegati' });

  useEffect(() => {
    if (props.running) { setSince((s) => s ?? Date.now()); const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }
    setSince(null);
    return undefined;
  }, [props.running]);

  // Aprendo il pannello si scrive subito.
  // Su telefono no: aprire la tastiera da sola non è da app.
  const shown = variant === 'page' || props.open;
  useEffect(() => { if (shown && !matchMedia('(pointer: coarse)').matches) requestAnimationFrame(() => area.current?.focus()); }, [shown]);

  useEffect(() => { if (area.current) autoGrow(area.current, 6 * 22 + 12); }, [draft, dict.interim, shown, hint.ghost]);

  const send = (text: string) => {
    if (dict.listening) dict.stop();
    const t = text.trim();
    if (!t) return;
    setDraft('');
    toBottom();
    props.onSend(t);
  };

  const v = dict;
  const canNotify = typeof Notification !== 'undefined';
  const [notify, setNotify] = useState(() => canNotify && Notification.permission === 'granted');

  return (
    <>
    {dropOverlay}
    <AnimatePresence>
      {props.open && variant === 'float' && (
        <motion.section
          key="dock"
          ref={dock}
          {...rise}
          role="dialog"
          aria-label="Chat con Ciccio"
          onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}
          style={{ transformOrigin: 'bottom right' }}
          className={`cc-sheet cc-front fixed inset-2 z-40 flex flex-col overflow-hidden rounded-[14px] border bg-panel sm:inset-auto sm:bottom-4 sm:h-[min(720px,calc(100dvh-32px))] sm:w-[440px] ${props.shifted ? 'sm:right-[488px]' : 'sm:right-4'}`}
        >
{phoneUi ? (
          <header className={`flex flex-none items-center gap-2.5 border-b border-line/70 px-3 ${isSheet ? 'touch-none pb-2.5' : 'py-2.5'}`}
            onPointerDown={isSheet ? (e) => { if (!(e.target as HTMLElement).closest('button')) drag.start(e); } : undefined}>
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-line bg-ink">
              {props.phase === 'idle' ? <PixelMark size={32} /> : <Orb state={PHASE_ORB[props.phase]} size={32} label={PHASE_LABEL[props.phase]} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <PixelWordmark />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={props.phase} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className={`truncate text-[12.5px] ${props.phase === 'idle' ? 'text-muted' : 'text-acid'}`}>
                  {PHASE_LABEL[props.phase]}
                </motion.span>
              </AnimatePresence>
            </div>
            <button type="button" onClick={props.onTalk} aria-label="Parla con Ciccio a voce" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-full bg-acid text-ink">
              <MicIcon size={19} />
            </button>
            <button type="button" onClick={() => setMoreOpen(true)} aria-label="Contesto e avvisi" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-soft">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
            </button>
            {isSheet && (
              <button type="button" onClick={props.onClose} aria-label="Chiudi la chat con Ciccio" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-muted">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
              </button>
            )}
          </header>
          ) : (
          <header className="flex items-center gap-3 border-b border-line/70 px-4 py-3">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-line bg-ink">
              {props.phase === 'idle' ? <PixelMark size={32} /> : <Orb state={PHASE_ORB[props.phase]} size={32} label={PHASE_LABEL[props.phase]} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <PixelWordmark />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={props.phase} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className={`text-[12.5px] ${props.phase === 'idle' ? 'text-muted' : 'text-acid'}`}>
                  {PHASE_LABEL[props.phase]}
                </motion.span>
              </AnimatePresence>
            </div>
            <button type="button" onClick={props.onTalk} title="Parla con Ciccio a voce, a mani libere"
              className="cc-press flex h-9 items-center gap-1.5 rounded-[8px] bg-acid px-2.5 text-[12.5px] font-semibold text-ink">
              <MicIcon size={15} /> Parla
            </button>
            {canNotify && (
              <button type="button" aria-pressed={notify}
                onClick={() => { if (Notification.permission === 'granted') return; void Notification.requestPermission().then((p) => setNotify(p === 'granted')); }}
                title={notify ? 'Avvisi sul computer attivi (si tolgono dalle impostazioni del browser)' : 'Ricevi gli avvisi di Ciccio come notifiche del computer'}
                aria-label={notify ? 'Avvisi sul computer attivi' : 'Attiva gli avvisi sul computer'}
                className={`cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border ${notify ? 'border-acid/50 text-acid' : 'border-line text-muted hover:text-text'}`}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 004 0" /></svg>
              </button>
            )}
            <ContextMeter context={props.context} warn={props.contextWarn} onCompact={() => void api.ciccioCompact()} onNewSession={() => void api.ciccioReset()} />
            <button type="button" onClick={props.onClose} aria-label="Riduci la chat con Ciccio" title="Riduci (Esc)"
              className="cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border border-line text-muted hover:text-text">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 13l6 6 6-6" /></svg>
            </button>
          </header>
          )}

          <div className="relative flex min-h-0 flex-1 flex-col">
            <ChatContainerRoot key={props.open ? 'open' : 'closed'} contextRef={scroller} className="relative min-h-0 flex-1">
              <ChatContainerContent scrollClassName="cc-scroll overscroll-contain">
                <Transcript
                  ciccio
                  messages={props.messages.slice(-200)}
                  approvals={props.approvals}
                  agentName="Ciccio"
                  running={props.running}
                  live={props.live}
                  runningSince={since}
                  onDecide={props.onDecide}
                  onOpenFile={props.onOpenFile}
                  fileUrl={props.fileUrl}
                  onOpenChat={props.onOpenChat}
                  empty="Chiedimi come stanno gli agenti, passa un lavoro a uno di loro o fatti leggere posta e calendario."
                />
                <AnimatePresence initial={false}>
                {props.messages.length === 0 && (
                  <motion.div key="suggestions" exit={{ opacity: 0, transition: quick }} className="flex flex-wrap justify-center gap-2 px-4 pb-6">
                    {SUGGESTIONS.map((s, i) => (
                      <motion.button key={s} type="button" onClick={() => send(s)}
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.06 + i * 0.04 } }}
                        className="cc-press rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-acid/50 hover:text-text">{s}</motion.button>
                    ))}
                  </motion.div>
                )}
                </AnimatePresence>
              </ChatContainerContent>
              <ScrollButton signal={news} className="bottom-2" />
            </ChatContainerRoot>
          </div>

          <div className="pt-2"><ContextWarning context={props.context} warn={props.contextWarn} running={props.running} onCompact={() => void api.ciccioCompact()} onNewSession={() => void api.ciccioReset()} /></div>
          <QuestionSlot approvals={props.approvals} from="Ciccio" onAnswer={props.onAnswer} compact className="px-2.5 pb-1" />
          <form onSubmit={(e) => { e.preventDefault(); send(draft); }} className="flex-none border-t border-line/70 p-2.5"
            style={isSheet ? { paddingBottom: 'max(10px, env(safe-area-inset-bottom))' } : undefined}>
            <AnimatePresence initial={false}>
              {hint.chip && <motion.div key="chip" {...collapse} className="flex overflow-hidden"><div className="flex pb-2">{hint.chip}</div></motion.div>}
            </AnimatePresence>
            <div className="relative flex items-end gap-1.5 rounded-[12px] border border-line-hi bg-ink p-1.5 focus-within:border-acid/60">
              <AnimatePresence>{slash.menu}</AnimatePresence>
              <label className="min-w-0 flex-1">
                <span className="sr-only">Scrivi a Ciccio</span>
                <textarea
                  ref={area}
                  rows={1}
                  {...slash.inputProps}
                  value={v.listening && v.interim ? `${draft ? `${draft} ` : ''}${v.interim}` : draft}
                  onChange={(e) => setDraft(listIndent(e.currentTarget))}
                  onKeyDown={(e) => {
                    if (slash.onKeyDown(e)) return;
                    if (hint.onKeyDown(e)) return;
                    if (recall(e)) return;
                    if (listEnter(e, setDraft, touch)) return;
                    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); }
                  }}
                  placeholder={v.listening ? 'Ti ascolto…' : hint.ghost ?? 'Scrivi a Ciccio…'}
                  className="cc-field block w-full resize-none bg-transparent px-2 py-1.5 text-[14.5px] leading-[22px] text-text outline-none placeholder:text-muted"
                />
              </label>
              {v.supported && (
                <button type="button" onClick={v.listening ? v.stop : () => void v.start()}
                  aria-label={v.listening ? 'Smetti di dettare' : 'Detta il messaggio'} title={v.error || (v.listening ? 'Ti ascolto: smetti di parlare e la frase arriva qui' : 'Detta il messaggio')}
                  className={`cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] ${v.listening ? 'bg-acid text-ink' : 'bg-acid/15 text-acid'}`}>
                  <MicIcon size={17} />
                </button>
              )}
              <AnimatePresence initial={false}>
                {props.running && (
                  <motion.button key="stop" {...pop} type="button" onClick={() => void api.ciccioStop()} aria-label="Ferma Ciccio" title="Ferma"
                    className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] border border-line-hi">
                    <span className="h-3 w-3 bg-text" />
                  </motion.button>
                )}
              </AnimatePresence>
              <button type="submit" disabled={!draft.trim()} aria-label="Invia a Ciccio"
                className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] bg-acid text-ink disabled:opacity-40">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
              </button>
            </div>
          </form>
        </motion.section>
      )}
      {props.open && isSheet && (
        <motion.div key="dock-sheet" className="cc-viewport z-[57]" initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
          <motion.div aria-hidden="true" onClick={props.onClose} className="absolute inset-0 bg-black/60"
            initial={{ opacity: 0 }} animate={{ opacity: 1, transition: sheetIn }} exit={{ opacity: 0, transition: sheetOut }} />
          <motion.section ref={dock} role="dialog" aria-label="Chat con Ciccio" onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}
            drag="y" dragControls={drag} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.04, bottom: 0.9 }}
            onDragEnd={(_, i) => { if (i.offset.y > 110 || i.velocity.y > 600) props.onClose(); }}
            initial={{ y: '100%' }} animate={{ y: 0, transition: sheetIn }} exit={{ y: '100%', transition: sheetOut }}
            style={{ height: 'calc(100% - var(--cc-top) - 12px)' }}
            className="cc-front absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[18px] border bg-panel">
            <div className="flex flex-none touch-none justify-center pt-2 pb-1" onPointerDown={(e) => drag.start(e)}><span className="h-[5px] w-9 rounded-full bg-line-hi" /></div>
{phoneUi ? (
          <header className={`flex flex-none items-center gap-2.5 border-b border-line/70 px-3 ${isSheet ? 'touch-none pb-2.5' : 'py-2.5'}`}
            onPointerDown={isSheet ? (e) => { if (!(e.target as HTMLElement).closest('button')) drag.start(e); } : undefined}>
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-line bg-ink">
              {props.phase === 'idle' ? <PixelMark size={32} /> : <Orb state={PHASE_ORB[props.phase]} size={32} label={PHASE_LABEL[props.phase]} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <PixelWordmark />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={props.phase} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className={`truncate text-[12.5px] ${props.phase === 'idle' ? 'text-muted' : 'text-acid'}`}>
                  {PHASE_LABEL[props.phase]}
                </motion.span>
              </AnimatePresence>
            </div>
            <button type="button" onClick={props.onTalk} aria-label="Parla con Ciccio a voce" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-full bg-acid text-ink">
              <MicIcon size={19} />
            </button>
            <button type="button" onClick={() => setMoreOpen(true)} aria-label="Contesto e avvisi" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-soft">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
            </button>
            {isSheet && (
              <button type="button" onClick={props.onClose} aria-label="Chiudi la chat con Ciccio" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-muted">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
              </button>
            )}
          </header>
          ) : (
          <header className="flex items-center gap-3 border-b border-line/70 px-4 py-3">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-line bg-ink">
              {props.phase === 'idle' ? <PixelMark size={32} /> : <Orb state={PHASE_ORB[props.phase]} size={32} label={PHASE_LABEL[props.phase]} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <PixelWordmark />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={props.phase} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className={`text-[12.5px] ${props.phase === 'idle' ? 'text-muted' : 'text-acid'}`}>
                  {PHASE_LABEL[props.phase]}
                </motion.span>
              </AnimatePresence>
            </div>
            <button type="button" onClick={props.onTalk} title="Parla con Ciccio a voce, a mani libere"
              className="cc-press flex h-9 items-center gap-1.5 rounded-[8px] bg-acid px-2.5 text-[12.5px] font-semibold text-ink">
              <MicIcon size={15} /> Parla
            </button>
            {canNotify && (
              <button type="button" aria-pressed={notify}
                onClick={() => { if (Notification.permission === 'granted') return; void Notification.requestPermission().then((p) => setNotify(p === 'granted')); }}
                title={notify ? 'Avvisi sul computer attivi (si tolgono dalle impostazioni del browser)' : 'Ricevi gli avvisi di Ciccio come notifiche del computer'}
                aria-label={notify ? 'Avvisi sul computer attivi' : 'Attiva gli avvisi sul computer'}
                className={`cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border ${notify ? 'border-acid/50 text-acid' : 'border-line text-muted hover:text-text'}`}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 004 0" /></svg>
              </button>
            )}
            <ContextMeter context={props.context} warn={props.contextWarn} onCompact={() => void api.ciccioCompact()} onNewSession={() => void api.ciccioReset()} />
            <button type="button" onClick={props.onClose} aria-label="Riduci la chat con Ciccio" title="Riduci (Esc)"
              className="cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border border-line text-muted hover:text-text">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 13l6 6 6-6" /></svg>
            </button>
          </header>
          )}

          <div className="relative flex min-h-0 flex-1 flex-col">
            <ChatContainerRoot key={props.open ? 'open' : 'closed'} contextRef={scroller} className="relative min-h-0 flex-1">
              <ChatContainerContent scrollClassName="cc-scroll overscroll-contain">
                <Transcript
                  ciccio
                  messages={props.messages.slice(-200)}
                  approvals={props.approvals}
                  agentName="Ciccio"
                  running={props.running}
                  live={props.live}
                  runningSince={since}
                  onDecide={props.onDecide}
                  onOpenFile={props.onOpenFile}
                  fileUrl={props.fileUrl}
                  onOpenChat={props.onOpenChat}
                  empty="Chiedimi come stanno gli agenti, passa un lavoro a uno di loro o fatti leggere posta e calendario."
                />
                <AnimatePresence initial={false}>
                {props.messages.length === 0 && (
                  <motion.div key="suggestions" exit={{ opacity: 0, transition: quick }} className="flex flex-wrap justify-center gap-2 px-4 pb-6">
                    {SUGGESTIONS.map((s, i) => (
                      <motion.button key={s} type="button" onClick={() => send(s)}
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.06 + i * 0.04 } }}
                        className="cc-press rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-acid/50 hover:text-text">{s}</motion.button>
                    ))}
                  </motion.div>
                )}
                </AnimatePresence>
              </ChatContainerContent>
              <ScrollButton signal={news} className="bottom-2" />
            </ChatContainerRoot>
          </div>

          <div className="pt-2"><ContextWarning context={props.context} warn={props.contextWarn} running={props.running} onCompact={() => void api.ciccioCompact()} onNewSession={() => void api.ciccioReset()} /></div>
          <QuestionSlot approvals={props.approvals} from="Ciccio" onAnswer={props.onAnswer} compact className="px-2.5 pb-1" />
          <form onSubmit={(e) => { e.preventDefault(); send(draft); }} className="flex-none border-t border-line/70 p-2.5"
            style={isSheet ? { paddingBottom: 'max(10px, env(safe-area-inset-bottom))' } : undefined}>
            <AnimatePresence initial={false}>
              {hint.chip && <motion.div key="chip" {...collapse} className="flex overflow-hidden"><div className="flex pb-2">{hint.chip}</div></motion.div>}
            </AnimatePresence>
            <div className="relative flex items-end gap-1.5 rounded-[12px] border border-line-hi bg-ink p-1.5 focus-within:border-acid/60">
              <AnimatePresence>{slash.menu}</AnimatePresence>
              <label className="min-w-0 flex-1">
                <span className="sr-only">Scrivi a Ciccio</span>
                <textarea
                  ref={area}
                  rows={1}
                  {...slash.inputProps}
                  value={v.listening && v.interim ? `${draft ? `${draft} ` : ''}${v.interim}` : draft}
                  onChange={(e) => setDraft(listIndent(e.currentTarget))}
                  onKeyDown={(e) => {
                    if (slash.onKeyDown(e)) return;
                    if (hint.onKeyDown(e)) return;
                    if (recall(e)) return;
                    if (listEnter(e, setDraft, touch)) return;
                    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); }
                  }}
                  placeholder={v.listening ? 'Ti ascolto…' : hint.ghost ?? 'Scrivi a Ciccio…'}
                  className="cc-field block w-full resize-none bg-transparent px-2 py-1.5 text-[14.5px] leading-[22px] text-text outline-none placeholder:text-muted"
                />
              </label>
              {v.supported && (
                <button type="button" onClick={v.listening ? v.stop : () => void v.start()}
                  aria-label={v.listening ? 'Smetti di dettare' : 'Detta il messaggio'} title={v.error || (v.listening ? 'Ti ascolto: smetti di parlare e la frase arriva qui' : 'Detta il messaggio')}
                  className={`cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] ${v.listening ? 'bg-acid text-ink' : 'bg-acid/15 text-acid'}`}>
                  <MicIcon size={17} />
                </button>
              )}
              <AnimatePresence initial={false}>
                {props.running && (
                  <motion.button key="stop" {...pop} type="button" onClick={() => void api.ciccioStop()} aria-label="Ferma Ciccio" title="Ferma"
                    className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] border border-line-hi">
                    <span className="h-3 w-3 bg-text" />
                  </motion.button>
                )}
              </AnimatePresence>
              <button type="submit" disabled={!draft.trim()} aria-label="Invia a Ciccio"
                className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] bg-acid text-ink disabled:opacity-40">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
              </button>
            </div>
          </form>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
    {variant === 'page' && (
      <section ref={dock} aria-label="Chat con Ciccio" className="flex min-h-0 flex-1 flex-col">
{phoneUi ? (
          <header className={`flex flex-none items-center gap-2.5 border-b border-line/70 px-3 ${isSheet ? 'touch-none pb-2.5' : 'py-2.5'}`}
            onPointerDown={isSheet ? (e) => { if (!(e.target as HTMLElement).closest('button')) drag.start(e); } : undefined}>
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-line bg-ink">
              {props.phase === 'idle' ? <PixelMark size={32} /> : <Orb state={PHASE_ORB[props.phase]} size={32} label={PHASE_LABEL[props.phase]} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <PixelWordmark />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={props.phase} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className={`truncate text-[12.5px] ${props.phase === 'idle' ? 'text-muted' : 'text-acid'}`}>
                  {PHASE_LABEL[props.phase]}
                </motion.span>
              </AnimatePresence>
            </div>
            <button type="button" onClick={props.onTalk} aria-label="Parla con Ciccio a voce" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-full bg-acid text-ink">
              <MicIcon size={19} />
            </button>
            <button type="button" onClick={() => setMoreOpen(true)} aria-label="Contesto e avvisi" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-soft">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
            </button>
            {isSheet && (
              <button type="button" onClick={props.onClose} aria-label="Chiudi la chat con Ciccio" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[10px] text-muted">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
              </button>
            )}
          </header>
          ) : (
          <header className="flex items-center gap-3 border-b border-line/70 px-4 py-3">
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-[10px] border border-line bg-ink">
              {props.phase === 'idle' ? <PixelMark size={32} /> : <Orb state={PHASE_ORB[props.phase]} size={32} label={PHASE_LABEL[props.phase]} />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <PixelWordmark />
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={props.phase} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className={`text-[12.5px] ${props.phase === 'idle' ? 'text-muted' : 'text-acid'}`}>
                  {PHASE_LABEL[props.phase]}
                </motion.span>
              </AnimatePresence>
            </div>
            <button type="button" onClick={props.onTalk} title="Parla con Ciccio a voce, a mani libere"
              className="cc-press flex h-9 items-center gap-1.5 rounded-[8px] bg-acid px-2.5 text-[12.5px] font-semibold text-ink">
              <MicIcon size={15} /> Parla
            </button>
            {canNotify && (
              <button type="button" aria-pressed={notify}
                onClick={() => { if (Notification.permission === 'granted') return; void Notification.requestPermission().then((p) => setNotify(p === 'granted')); }}
                title={notify ? 'Avvisi sul computer attivi (si tolgono dalle impostazioni del browser)' : 'Ricevi gli avvisi di Ciccio come notifiche del computer'}
                aria-label={notify ? 'Avvisi sul computer attivi' : 'Attiva gli avvisi sul computer'}
                className={`cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border ${notify ? 'border-acid/50 text-acid' : 'border-line text-muted hover:text-text'}`}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z" /><path d="M10 20a2 2 0 004 0" /></svg>
              </button>
            )}
            <ContextMeter context={props.context} warn={props.contextWarn} onCompact={() => void api.ciccioCompact()} onNewSession={() => void api.ciccioReset()} />
            <button type="button" onClick={props.onClose} aria-label="Riduci la chat con Ciccio" title="Riduci (Esc)"
              className="cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border border-line text-muted hover:text-text">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 13l6 6 6-6" /></svg>
            </button>
          </header>
          )}

          <div className="relative flex min-h-0 flex-1 flex-col">
            <ChatContainerRoot key={props.open ? 'open' : 'closed'} contextRef={scroller} className="relative min-h-0 flex-1">
              <ChatContainerContent scrollClassName="cc-scroll overscroll-contain">
                <Transcript
                  ciccio
                  messages={props.messages.slice(-200)}
                  approvals={props.approvals}
                  agentName="Ciccio"
                  running={props.running}
                  live={props.live}
                  runningSince={since}
                  onDecide={props.onDecide}
                  onOpenFile={props.onOpenFile}
                  fileUrl={props.fileUrl}
                  onOpenChat={props.onOpenChat}
                  empty="Chiedimi come stanno gli agenti, passa un lavoro a uno di loro o fatti leggere posta e calendario."
                />
                <AnimatePresence initial={false}>
                {props.messages.length === 0 && (
                  <motion.div key="suggestions" exit={{ opacity: 0, transition: quick }} className="flex flex-wrap justify-center gap-2 px-4 pb-6">
                    {SUGGESTIONS.map((s, i) => (
                      <motion.button key={s} type="button" onClick={() => send(s)}
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.06 + i * 0.04 } }}
                        className="cc-press rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-acid/50 hover:text-text">{s}</motion.button>
                    ))}
                  </motion.div>
                )}
                </AnimatePresence>
              </ChatContainerContent>
              <ScrollButton signal={news} className="bottom-2" />
            </ChatContainerRoot>
          </div>

          <div className="pt-2"><ContextWarning context={props.context} warn={props.contextWarn} running={props.running} onCompact={() => void api.ciccioCompact()} onNewSession={() => void api.ciccioReset()} /></div>
          <QuestionSlot approvals={props.approvals} from="Ciccio" onAnswer={props.onAnswer} compact className="px-2.5 pb-1" />
          <form onSubmit={(e) => { e.preventDefault(); send(draft); }} className="flex-none border-t border-line/70 p-2.5"
            style={isSheet ? { paddingBottom: 'max(10px, env(safe-area-inset-bottom))' } : undefined}>
            <AnimatePresence initial={false}>
              {hint.chip && <motion.div key="chip" {...collapse} className="flex overflow-hidden"><div className="flex pb-2">{hint.chip}</div></motion.div>}
            </AnimatePresence>
            <div className="relative flex items-end gap-1.5 rounded-[12px] border border-line-hi bg-ink p-1.5 focus-within:border-acid/60">
              <AnimatePresence>{slash.menu}</AnimatePresence>
              <label className="min-w-0 flex-1">
                <span className="sr-only">Scrivi a Ciccio</span>
                <textarea
                  ref={area}
                  rows={1}
                  {...slash.inputProps}
                  value={v.listening && v.interim ? `${draft ? `${draft} ` : ''}${v.interim}` : draft}
                  onChange={(e) => setDraft(listIndent(e.currentTarget))}
                  onKeyDown={(e) => {
                    if (slash.onKeyDown(e)) return;
                    if (hint.onKeyDown(e)) return;
                    if (recall(e)) return;
                    if (listEnter(e, setDraft, touch)) return;
                    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); }
                  }}
                  placeholder={v.listening ? 'Ti ascolto…' : hint.ghost ?? 'Scrivi a Ciccio…'}
                  className="cc-field block w-full resize-none bg-transparent px-2 py-1.5 text-[14.5px] leading-[22px] text-text outline-none placeholder:text-muted"
                />
              </label>
              {v.supported && (
                <button type="button" onClick={v.listening ? v.stop : () => void v.start()}
                  aria-label={v.listening ? 'Smetti di dettare' : 'Detta il messaggio'} title={v.error || (v.listening ? 'Ti ascolto: smetti di parlare e la frase arriva qui' : 'Detta il messaggio')}
                  className={`cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] ${v.listening ? 'bg-acid text-ink' : 'bg-acid/15 text-acid'}`}>
                  <MicIcon size={17} />
                </button>
              )}
              <AnimatePresence initial={false}>
                {props.running && (
                  <motion.button key="stop" {...pop} type="button" onClick={() => void api.ciccioStop()} aria-label="Ferma Ciccio" title="Ferma"
                    className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] border border-line-hi">
                    <span className="h-3 w-3 bg-text" />
                  </motion.button>
                )}
              </AnimatePresence>
              <button type="submit" disabled={!draft.trim()} aria-label="Invia a Ciccio"
                className="cc-press flex h-9 w-9 flex-none items-center justify-center rounded-[8px] bg-acid text-ink disabled:opacity-40">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
              </button>
            </div>
          </form>
      </section>
    )}
    {phoneUi && (
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} label="Contesto e avvisi di Ciccio" title="Ciccio">
        <div className="flex flex-col gap-3">
          <ContextPanel context={props.context} warn={props.contextWarn}
            onCompact={() => { setMoreOpen(false); void api.ciccioCompact(); }} onNewSession={() => { setMoreOpen(false); void api.ciccioReset(); }} />
          {canNotify && (
            <div className="flex flex-col">
              <SheetRow label="Avvisi come notifiche" detail={notify ? 'attive' : 'spente'} chevron={!notify}
                onClick={() => { if (Notification.permission === 'granted') return; void Notification.requestPermission().then((p) => setNotify(p === 'granted')); }} />
            </div>
          )}
        </div>
      </Sheet>
    )}
    </>
  );
}

/**
 * Bolla per riaprire la chat: segnala le risposte non lette e quando Ciccio sta lavorando.
 * Si sposta a sinistra (con animazione) quando c'è un pannello aperto a destra e resta sempre al suo posto
 * mentre scorri; sparisce solo dove sarebbe d'intralcio.
 */
export function CiccioBubble(props: { visible: boolean; unread: number; running: boolean; onOpen: () => void; shifted?: boolean }) {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  // Su telefono il pannello di un agente occupa tutto lo schermo: lì la bolla non serve.
  const show = props.visible && !(props.shifted && narrow);
  return (
    <AnimatePresence>
      {show && (
        <motion.button key="bubble" type="button" onClick={props.onOpen}
          initial={{ opacity: 0, scale: 0.92, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0, right: props.shifted ? 488 : 16, transition: { duration: 0.28, ease: [0.25, 1, 0.5, 1] } }}
          exit={{ opacity: 0, scale: 0.92, y: 12, transition: { duration: 0.16 } }}
          aria-label={`Apri la chat con Ciccio${props.unread ? `, ${props.unread} risposte nuove` : ''}`} title="Chat con Ciccio (⌘K)"
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)', right: props.shifted ? 488 : 16 }}
          className="cc-press fixed z-40 flex h-14 items-center gap-2.5 rounded-[14px] border border-line-hi bg-panel py-2 pr-4 pl-2 shadow-[0_6px_8px_rgb(0_0_0/.45)]">
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-ink">
            {props.running ? <Orb state="solving" size={32} label="Ciccio sta lavorando" /> : <PixelMark size={32} />}
          </span>
          <PixelWordmark />
          <AnimatePresence>
            {props.unread > 0 && (
              <motion.span key="n" {...pop} className="flex h-5 min-w-5 items-center justify-center bg-acid px-1 font-mono text-[11px] font-semibold text-ink">{props.unread}</motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      )}
    </AnimatePresence>
  );
}

/** Ultime risposte di Ciccio dopo l'ultimo messaggio dell'utente, in testo semplice da leggere a voce. */
export function lastCiccioReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  return messages
    .filter((m) => m.agentId === CICCIO_THREAD && (m.role === 'agent' || m.role === 'ciccio') && (!lastUser || m.id > lastUser.id))
    .map((m) => m.text.replace(/[*_`#>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'))
    .join('\n');
}
