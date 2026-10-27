import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Disclosure } from '@heroui/react';
import { collapse, pop, quick, slideRight, smooth } from './motion';
import { api, timeAgo, fileBaseOf } from './api';
import { AlwaysLabel, ApprovalDetail, SendIcon, StatusPill, alwaysOnly, alwaysRule, approvalParts, toolLabel } from './ui';
import { VoiceNote, voiceNoteSupported } from './voice/VoiceNote';
import type { StickToBottomContext } from 'use-stick-to-bottom';
import { ChatContainerContent, ChatContainerRoot, ScrollButton } from './chat/ChatContainer';
import { Markdown } from './chat/Markdown';
import { CopyButton } from './chat/CopyButton';
import { copyText } from './chat/fileActions';
import { listEnter, listIndent } from './listContinue';
import { autoGrow } from './autoGrow';
import { AttachmentChips, SentAttachments, pastedFiles, useAttachments } from './chat/attachments';
import { useFileDrop } from './chat/FileUpload';
import { sentTexts, useSentHistory } from './sentHistory';
import { usePromptSuggestion } from './promptSuggestion';
import { useSlashCommands } from './slashCommands';
import { useDraft } from './drafts';
import { PermissionHint } from './PermissionHint';
import { QuestionSlot, onlyPermissions } from './QuestionPanel';
import { groupSteps, stepsSummary } from './chat/Steps';
import { toolMeta, toolState } from './chat/Tool';
import { SystemMessage } from './chat/SystemMessage';
import { PERMISSION_LEVELS, type AgentView, type Approval, type ChatMessage, type ChatView, type PermissionLevel } from '../../shared/types';

function Bubble({ m, agentName, fileBase, onOpenFile }: { m: ChatMessage; agentName: string; fileBase?: string; onOpenFile?: (path: string) => void }) {
  if (m.role === 'tool') {
    return <SystemMessage text={m.text} compact />;
  }
  // Inviati a destra (tu, o Ciccio per conto tuo), ricevuti a sinistra.
  const mine = m.role === 'user' || m.role === 'ciccio';
  const tone =
    m.role === 'ciccio' ? 'border border-acid/25 bg-acid/[.06] rounded-[14px_14px_4px_14px]'
      : m.role === 'error' ? 'border border-block/40 bg-block/[.07] rounded-[14px_14px_14px_4px]'
        : mine ? 'border border-[oklch(0.4_0.07_128)] bg-[oklch(0.25_0.035_128)] text-text rounded-[14px_14px_4px_14px]'
          : 'border border-line bg-panel-hi rounded-[14px_14px_14px_4px]';
  const who = m.role === 'ciccio' ? 'Da Ciccio' : m.role === 'error' ? 'Errore' : mine ? 'Tu' : agentName;
  const atts = m.meta?.kind === 'user' ? m.meta.attachments : [];
  return (
    <div className={`${mine ? 'cc-in-right items-end' : 'cc-in items-start'} flex flex-col gap-1.5`}>
      <SentAttachments atts={atts} fileBase={fileBase} onOpen={onOpenFile} align={mine ? 'end' : 'start'} />
      <div className={`cc-selectable min-w-0 max-w-[88%] break-words px-3 py-2.5 text-[14px] leading-relaxed text-soft ${tone}`}>
        <div className={`mb-1 text-[12px] font-semibold ${m.role === 'ciccio' ? 'text-acid' : m.role === 'error' ? 'text-block' : 'text-muted'}`}>{who}</div>
        {m.role === 'agent' || m.role === 'user' ? <Markdown text={m.text} fileBase={fileBase} onOpenFile={onOpenFile} /> : <div className="whitespace-pre-wrap">{m.text}</div>}
      </div>
      {m.role === 'agent' && m.text.trim() && <CopyButton copy={() => copyText(m.text.trim())} label="Copia la risposta" className="-mt-1 h-8 w-8 rounded-[7px] hover:bg-panel-hi" />}
    </div>
  );
}

const STEP_MARK = { run: '…', ok: '✓', error: '✗', skipped: '–', denied: '⊘' } as const;

/** Passaggi di fila (strumenti e ragionamento), compatti: una riga «↳ 12 passaggi · Bash, Read…» che si apre sull'elenco. */
function PanelSteps({ items }: { items: ChatMessage[] }) {
  const s = stepsSummary(items);
  return (
    <Disclosure className="cc-in min-w-0">
      <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-1.5 pl-1 text-left font-mono text-[12px] text-muted hover:text-soft">
        <span className="flex-none">↳</span>
        <span className="flex-none text-soft">{s.count ? s.label : 'ragionamento'}</span>
        {s.names && <span className="min-w-0 truncate">· {s.names}</span>}
        {s.errors && <span className="flex-none text-block">· {s.errors}</span>}
        <Disclosure.Indicator className="ms-0 size-3 flex-none" />
      </Disclosure.Trigger>
      <Disclosure.Content>
        <div className="ml-2 mt-1 flex flex-col gap-0.5 border-l-2 border-line pl-2.5">
          {items.map((m) => {
            const t = toolMeta(m);
            const st = t ? toolState(t) : null;
            return (
              <div key={m.id} className="truncate font-mono text-[12px] text-muted" title={m.text}>
                {st ? <span className={st === 'ok' ? 'text-done' : st === 'error' ? 'text-block' : ''}>{STEP_MARK[st]} </span> : '· '}
                {m.role === 'thinking' ? `ragionamento: ${m.text.split('\n')[0]}` : m.text}
              </div>
            );
          })}
        </div>
      </Disclosure.Content>
    </Disclosure>
  );
}

/** Nome dell'agente modificabile: cambia solo in Ciccio, non su GitHub. */
export function AgentName({ agent, big = false }: { agent: AgentView; big?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(agent.name);
  const save = async () => {
    setEditing(false);
    if (value.trim() !== agent.name) await api.rename(agent.id, value === agent.id ? '' : value);
  };
  if (editing) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="flex min-w-0 items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Nome dell'agente in Ciccio</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => void save()}
            onKeyDown={(e) => { if (e.key === 'Escape') { setValue(agent.name); setEditing(false); } }}
            placeholder={agent.id}
            className={`w-full rounded-lg border border-acid bg-ink px-2 py-1 font-medium text-text outline-none ${big ? 'text-[20px]' : 'text-[17px]'}`} />
        </label>
      </form>
    );
  }
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`cc-wrap font-semibold ${big ? 'text-[20px]' : 'text-[17px]'}`}>{agent.name}</span>
        <button type="button" onClick={() => { setValue(agent.name); setEditing(true); }} aria-label="Rinomina in Ciccio" title="Rinomina (solo in Ciccio)"
          className="cc-press flex h-8 w-8 flex-none items-center justify-center rounded-lg text-muted hover:text-acid">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></svg>
        </button>
      </div>
      {agent.name !== agent.id && <span className="break-all font-mono text-[12px] text-muted">{agent.id}</span>}
    </div>
  );
}

/** Livello di autorizzazione della chat, come in Claude Code; cambia subito, anche a sessione avviata. */
function PermissionPicker({ chat }: { chat: ChatView }) {
  const [saving, setSaving] = useState(false);
  const risky = chat.permission === 'bypass';
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-[13px] text-muted">
        Autorizzazioni
        <select
          value={chat.permission}
          disabled={saving}
          onChange={async (e) => {
            setSaving(true);
            try { await api.setPermission(chat.id, e.target.value as PermissionLevel); } finally { setSaving(false); }
          }}
          className={`min-h-9 rounded-lg border bg-ink px-2 text-[13px] font-medium outline-none ${risky ? 'border-wait/60 text-wait' : 'border-line text-text'}`}
        >
          {PERMISSION_LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
        </select>
      </label>
      <PermissionHint chatId={chat.id} permission={chat.permission} />
    </div>
  );
}

export function AgentPanel(props: {
  agent: AgentView;
  /** Chat mostrata; assente se il progetto non ne ha ancora (la prima si crea scrivendo). */
  chat?: ChatView;
  messages: ChatMessage[];
  approvals: Approval[];
  onDecide: (id: string, allow: boolean, always?: boolean) => void;
  /** Risposte a una domanda a scelte dell'agente. */
  onAnswer: (id: string, answers: Record<string, string>) => Promise<void>;
  onClose: () => void;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => Promise<ChatView>;
  /** 'side' accanto alla griglia, 'page' nella pagina dedicata all'agente. */
  variant?: 'side' | 'page';
  onExpand?: () => void;
  /** Apre un file del repo nell'anteprima. */
  onOpenFile?: (path: string) => void;
}) {
  const { agent, chat, messages, approvals } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const page = props.variant === 'page';
  // Bozza della chat (o del progetto, se non ha ancora chat): cambiando chat si ritrova.
  const draftKey = chat ? `chat:${chat.id}` : `agent:${agent.id}`;
  const [draft, setDraft] = useDraft(draftKey);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(40);
  const shown = messages.slice(-limit);
  const history = useMemo(() => sentTexts(messages), [messages]);
  const recall = useSentHistory(history, draft, setDraft, chat?.id ?? agent.id);
  const news = `${messages.length}:${messages[messages.length - 1]?.id}:${approvals.length}`;
  const scroller = useRef<StickToBottomContext>(null);
  // Mandando un messaggio si torna in fondo, anche se si stava leggendo più su.
  const toBottom = () => { void scroller.current?.scrollToBottom(); };

  // Allegati: incollati, trascinati o scelti con la graffetta, caricati subito nel repo dell'agente.
  const files = useAttachments(agent.id, draftKey);
  const picker = useRef<HTMLInputElement>(null);
  // File trascinati in qualsiasi punto della finestra (anche sulla dashboard accanto): allegati di questa chat.
  const panel = useRef<HTMLElement>(null);
  const dropOverlay = useFileDrop(panel, { to: `a ${agent.name}${chat ? ` · ${chat.title}` : ''}`, onFiles: (f) => void files.add(f), fallback: true });
  const canSend = !files.uploading && (draft.trim().length > 0 || files.ready.length > 0);

  const send = async (text: string) => {
    const t = text.trim();
    const atts = files.ready;
    if (files.uploading || (!t && !atts.length)) return;
    setDraft('');
    setError('');
    files.clear();
    toBottom();
    try { await api.send((chat ?? await props.onNewChat()).id, t, atts); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setDraft(t); }
  };
  // Vocale: parte da solo come messaggio, senza allegati e senza toccare quello che stai scrivendo.
  const sendVoice = async (t: string) => {
    setError('');
    toBottom();
    await api.send((chat ?? await props.onNewChat()).id, t);
  };
  const hint = usePromptSuggestion({ suggestion: chat?.suggestion, value: draft, setValue: setDraft, area, touch });
  const slash = useSlashCommands({ source: agent.id, value: draft, setValue: setDraft, area, off: recall.browsing });
  // Altezza che segue il testo (o il suggerimento in grigio), fino a 6 righe: solo quando il testo cambia, non a ogni messaggio in arrivo.
  useEffect(() => { if (area.current) autoGrow(area.current, 6 * 21 + 8); }, [draft, hint.ghost]);


  return (
    <motion.section ref={panel} {...(page ? {} : slideRight)} aria-label={`Agente ${agent.id}`} className={page
      ? 'cc-in flex h-[calc(100vh-120px)] min-h-[480px] min-w-0 flex-[999_1_560px] flex-col gap-4 rounded-[14px] border border-line bg-panel p-5 sm:p-6'
      // Pannello fisso alto quanto lo schermo: la pagina sotto non deve mai scorrere per leggere o scrivere.
      // cc-front: filo acido e alone, per staccarlo dalle card che ha sotto.
      : 'cc-sheet cc-front fixed inset-2 z-30 flex min-w-0 flex-col gap-4 rounded-[14px] border bg-panel p-5 sm:inset-y-4 sm:right-4 sm:left-auto sm:w-[460px]'}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <AgentName agent={agent} />
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={chat?.status ?? agent.status} />
            <span className="font-mono text-[12px] text-muted">{timeAgo(chat?.lastActivity ?? agent.lastActivity)}{chat?.queued ? ' · in coda' : ''}</span>
          </div>
        </div>
        <div className="flex flex-none gap-2">
          <AnimatePresence initial={false}>
          {chat?.running && (
            <motion.button key="stop" {...pop} type="button" onClick={() => void api.stop(chat.id)} className="cc-press h-11 rounded-xl border border-line px-3 text-[13px] text-soft">Ferma</motion.button>
          )}
          {chat?.status === 'block' && (
            <motion.button key="unblock" {...pop} type="button" onClick={() => void api.clearError(chat.id)} className="cc-press h-11 rounded-xl border border-line px-3 text-[13px] text-soft">Sblocca</motion.button>
          )}
          </AnimatePresence>
          <button type="button" onClick={() => { void api.setHidden(agent.id, true); props.onClose(); }} title="Nascondi il progetto in Ciccio (lo rimostri dalle Impostazioni › Progetti)" aria-label="Nascondi il progetto"
            className="cc-press flex h-11 w-11 items-center justify-center rounded-xl border border-line text-muted hover:text-text">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 6.1A10.8 10.8 0 0112 6c5 0 9 6 9 6a17.4 17.4 0 01-3.2 3.9M6.2 6.6C3.9 8.3 3 12 3 12s4 6 9 6a9.4 9.4 0 004.5-1.2M9.9 9.9a3 3 0 004.2 4.2" /></svg>
          </button>
          {props.onExpand && (
            <button type="button" onClick={props.onExpand} aria-label="Apri la pagina dell'agente" title="Apri la pagina dell'agente" className="cc-press flex h-11 w-11 items-center justify-center rounded-xl border border-line text-muted hover:text-acid">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" /></svg>
            </button>
          )}
          {!page && (
            <button type="button" onClick={props.onClose} aria-label="Chiudi il dettaglio" className="cc-press flex h-11 w-11 items-center justify-center rounded-xl border border-line text-muted">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          )}
        </div>
      </div>
      {/* Chat del progetto: riga intera sotto il nome, così il menu non si stringe accanto ai pulsanti. */}
      <div className="-mt-1 flex items-center gap-2">
            {agent.chats.length > 0 && (
              <label className="min-w-0 flex-1">
                <span className="sr-only">Chat del progetto</span>
                <select value={chat?.id} onChange={(e) => props.onSelectChat(e.target.value)}
                  className="min-h-9 w-full rounded-lg border border-line bg-ink px-2 text-[13px] text-text outline-none">
                  {agent.chats.map((c) => <option key={c.id} value={c.id}>{c.title}{c.running ? ' · al lavoro' : ''}</option>)}
                </select>
              </label>
            )}
            <button type="button" onClick={() => void props.onNewChat()} className="cc-press min-h-9 flex-none rounded-lg border border-line px-2.5 text-[13px] text-soft hover:text-text">+ Nuova chat</button>
          </div>

      <div className="relative flex min-h-[120px] flex-1 flex-col">
      <ChatContainerRoot key={chat?.id ?? agent.id} contextRef={scroller} className="relative -mr-2 min-h-0 flex-1">
      <ChatContainerContent className="gap-2.5 pr-2" scrollClassName="cc-scroll overscroll-contain">
        {messages.length > shown.length && (
          <button type="button" onClick={() => setLimit((l) => l + 40)} className="cc-press self-center rounded-full border border-line px-3 py-1.5 text-[12px] text-muted hover:text-text">
            Mostra precedenti ({messages.length - shown.length})
          </button>
        )}
        {messages.length === 0 && (
          <div className="py-6 text-center text-[14px] text-muted">Nessun messaggio. Scrivi all'agente per iniziare: lavorerà sul repo <span className="font-mono">{agent.id}</span>.</div>
        )}
        {groupSteps(shown).map((g) => g.run
          ? <PanelSteps key={`passi:${g.items[0].id}`} items={g.items} />
          : <Bubble key={g.items[0].id} m={g.items[0]} agentName={agent.name} fileBase={fileBaseOf(agent.id, chat?.id)} onOpenFile={props.onOpenFile} />)}
        <AnimatePresence initial={false}>
        {onlyPermissions(approvals).map((a) => (
          <motion.div key={a.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: smooth }} exit={{ opacity: 0, scale: 0.97, transition: quick }}
            className="cc-glow flex flex-col gap-2.5 rounded-[12px] border border-wait/45 bg-wait/[.06] p-3.5">
            <div className="cc-wrap text-[13px] font-semibold text-wait">Permesso · {toolLabel(a.tool)}</div>
            <ApprovalDetail a={a} />
            {approvalParts(a).reason && <div className="text-[12px] text-muted">{approvalParts(a).reason}</div>}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => props.onDecide(a.id, true, alwaysOnly(a.tool))} className="cc-press min-h-11 flex-1 rounded-xl bg-acid px-3 text-[14px] font-semibold text-ink">{alwaysOnly(a.tool) ? 'Consenti sempre' : 'Consenti'}</button>
              {alwaysRule(a) && (
              <button type="button" onClick={() => props.onDecide(a.id, true, true)} className="cc-press min-h-11 min-w-0 flex-1 rounded-xl border border-line-hi px-3 text-[14px] font-medium"><AlwaysLabel rule={alwaysRule(a)!} label="Consenti sempre" /></button>
              )}
              <button type="button" onClick={() => props.onDecide(a.id, false)} className="cc-press min-h-11 flex-1 rounded-xl border border-line-hi px-3 text-[14px] font-medium">Rifiuta</button>
            </div>
          </motion.div>
        ))}
        </AnimatePresence>
      </ChatContainerContent>
      <ScrollButton signal={news} className="bottom-2" />
      </ChatContainerRoot>
      </div>

      <QuestionSlot approvals={approvals} from={agent.name} onAnswer={props.onAnswer} compact />
      {chat && <PermissionPicker chat={chat} />}
      <AnimatePresence initial={false}>
      {error && <motion.div key="error" {...collapse} className="overflow-hidden text-[13px] text-block">{error}</motion.div>}
      </AnimatePresence>
      <form onSubmit={(e) => { e.preventDefault(); void send(draft); }} className="relative flex items-end gap-2">
        <div className="relative flex min-w-0 flex-1 flex-col rounded-[14px] border border-line bg-ink px-1.5 py-1.5 focus-within:border-acid/60">
          <AnimatePresence>{slash.menu}</AnimatePresence>
          <AnimatePresence initial={false}>
            {hint.chip && <motion.div key="chip" {...collapse} className="flex overflow-hidden"><div className="flex px-0.5 pb-1.5">{hint.chip}</div></motion.div>}
          </AnimatePresence>
          <AttachmentChips files={files.files} onRemove={files.remove} onOpen={props.onOpenFile} />
          <div className="flex min-h-8 items-end gap-1">
            <input ref={picker} type="file" multiple hidden onChange={(e) => { void files.add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
            <button type="button" onClick={() => picker.current?.click()} aria-label="Allega file" title="Allega file (anche incollando o trascinando)"
              className="cc-press flex h-8 w-8 flex-none items-center justify-center rounded-[8px] text-muted hover:text-text">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l9.2-9.2a3.7 3.7 0 015.2 5.2l-9.2 9.2a1.8 1.8 0 01-2.6-2.6l8.5-8.5" /></svg>
            </button>
            <label className="min-w-0 flex-1">
              <span className="sr-only">Messaggio a {agent.id}</span>
              {/* Va a capo da solo; Invio manda, Maiusc+Invio va a capo (sul telefono Invio va a capo); dentro un elenco Invio aggiunge la voce. */}
              <textarea
                ref={area}
                rows={1}
                {...slash.inputProps}
                value={draft}
                onChange={(e) => setDraft(listIndent(e.currentTarget))}
                onKeyDown={(e) => {
                  if (slash.onKeyDown(e)) return;
                  if (hint.onKeyDown(e)) return;
                  if (recall(e)) return;
                  if (listEnter(e, setDraft, touch)) return;
                  if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) void send(draft); }
                }}
                onPaste={(e) => {
                  const pasted = pastedFiles(e);
                  if (pasted.length) { e.preventDefault(); void files.add(pasted); }
                }}
                placeholder={hint.ghost ?? `Scrivi a ${agent.name}…`}
                className="cc-field block w-full min-w-0 resize-none bg-transparent px-1 py-1 text-[14px] leading-[21px] text-text outline-none placeholder:text-muted"
              />
            </label>
          </div>
        </div>
        {voiceNoteSupported() && (
          <VoiceNote onSend={sendVoice} onKeep={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} iconSize={20}
            className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[14px] bg-acid text-ink"
            stripClassName="rounded-[14px] border border-line-hi bg-ink" />
        )}
        <button type="submit" aria-label="Invia" className="cc-press flex h-11 w-11 flex-none items-center justify-center rounded-[14px] border border-line-hi text-text">
          <SendIcon />
        </button>
      </form>
      {dropOverlay}
    </motion.section>
  );
}
