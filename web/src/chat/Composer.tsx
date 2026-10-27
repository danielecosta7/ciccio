import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { collapse, pop } from '../motion';
import { listEnter, listIndent } from '../listContinue';
import { autoGrow } from '../autoGrow';
import { AttachmentChips, pastedFiles, type PendingFile } from './attachments';
import { useSentHistory } from '../sentHistory';
import { usePromptSuggestion } from '../promptSuggestion';
import { useSlashCommands } from '../slashCommands';
import { PermissionHint } from '../PermissionHint';
import { api } from '../api';
import { haptic } from '../haptic';
import { Segmented, Sheet } from '../Sheet';
import { VoiceNote, voiceNoteSupported } from '../voice/VoiceNote';
import { EFFORTS, MODELS, PERMISSION_LEVELS, type ChatView, type Effort, type PermissionLevel } from '../../../shared/types';

export type { PendingFile };

const SendArrow = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
);

export function Composer(props: {
  agentName: string;
  chat: ChatView;
  draft: string;
  setDraft: (v: string) => void;
  files: PendingFile[];
  onAddFiles: (files: File[]) => void;
  onRemoveFile: (key: string) => void;
  /** Anteprima di un allegato già caricato. */
  onOpenFile?: (path: string) => void;
  onSend: () => void;
  /** Vocale trascritto: parte da solo come messaggio, senza toccare quello che stai scrivendo. */
  onVoice: (text: string) => Promise<void>;
  onModel: (model: string, effort: Effort) => void;
  /** Messaggi già mandati in questa chat, per la freccia su. */
  history: string[];
  /** Telefono: campo su una riga, opzioni in un foglio. */
  phone?: boolean;
  /** C'è un permesso da decidere sopra il campo: niente targhetta delle opzioni. */
  pending?: boolean;
}) {
  const { chat } = props;
  const model = chat.model;
  const effort = chat.effort;
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const draftRef = useRef(props.draft);
  draftRef.current = props.draft;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const recall = useSentHistory(props.history, props.draft, props.setDraft, chat.id);
  const uploading = props.files.some((f) => f.uploading);
  // Sul telefono Invio va a capo, come in Messaggi: si manda con il pulsante.
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const canSend = !uploading && (props.draft.trim().length > 0 || props.files.some((f) => f.att));
  const hint = usePromptSuggestion({ suggestion: chat.suggestion, value: props.draft, setValue: props.setDraft, area, touch, });
  const slash = useSlashCommands({ source: chat.agentId, value: props.draft, setValue: props.setDraft, area, off: recall.browsing });

  // Altezza che segue il testo (o il suggerimento in grigio), fino a 8 righe (6 sul telefono).
  useEffect(() => { if (area.current) autoGrow(area.current, (props.phone ? 6 : 8) * 22 + 12); }, [props.draft, hint.ghost, props.phone]);

  const send = () => { if (!canSend) return; haptic('tap'); props.onSend(); };
  const select = 'min-h-9 rounded-[8px] border border-line bg-ink px-2 font-mono text-[12px] text-soft outline-none hover:border-line-hi';
  const level = PERMISSION_LEVELS.find((l) => l.key === chat.permission);
  const modelLabel = MODELS.find((m) => m.id === model)?.label ?? model;

  const field = (
    <label className="block min-w-0 flex-1">
      <span className="sr-only">Messaggio a {props.agentName}</span>
      <textarea
        ref={area}
        rows={1}
        {...slash.inputProps}
        value={props.draft}
        onChange={(e) => props.setDraft(listIndent(e.currentTarget))}
        onKeyDown={(e) => {
          if (slash.onKeyDown(e)) return;
          if (hint.onKeyDown(e)) return;
          if (recall(e)) return;
          // Dentro un elenco Invio aggiunge la voce successiva; Ctrl/Cmd+Invio manda comunque.
          if (listEnter(e, props.setDraft, touch)) return;
          if (e.key === 'Enter' && !e.shiftKey && !touch && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
        }}
        onPaste={(e) => {
          const pasted = pastedFiles(e);
          if (pasted.length) { e.preventDefault(); props.onAddFiles(pasted); }
        }}
        placeholder={hint.ghost ?? (props.phone ? (props.pending ? 'Oppure scrivi…' : 'Scrivi un messaggio…') : touch ? `Scrivi a ${props.agentName}…` : `Scrivi a ${props.agentName}… (Invio manda, Maiusc+Invio va a capo, incolla immagini e file)`)}
        enterKeyHint={touch ? 'enter' : 'send'}
        className={`cc-field block w-full resize-none bg-transparent text-text outline-none placeholder:text-muted ${props.phone ? 'px-1 py-[9px] text-[16px] leading-[22px]' : 'px-1.5 py-1 text-[14.5px] leading-[22px]'}`}
      />
    </label>
  );
  const filePicker = <input ref={picker} type="file" multiple hidden onChange={(e) => { props.onAddFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />;
  const stop = (cls: string) => (
    <AnimatePresence initial={false}>
      {chat.running && (
        <motion.button key="stop" {...pop} type="button" onClick={() => { haptic('warn'); void api.stop(chat.id); }} aria-label="Ferma l'agente" title="Ferma" className={cls}>
          <span className="h-3 w-3 bg-text" />
        </motion.button>
      )}
    </AnimatePresence>
  );

  if (props.phone) {
    // Telefono: [+] testo [microfono o invio] [stop]; sopra, una targhetta con livello, modello ed effort.
    return (
      <div className="w-full px-3 pt-1" style={{ paddingBottom: 'max(8px, env(safe-area-inset-bottom))' }}>
        {!props.pending && (
          <button type="button" onClick={() => setOptionsOpen(true)} aria-label="Opzioni della chat: autorizzazioni, modello ed effort"
            className={`cc-press mb-2 inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium ${chat.permission === 'bypass' ? 'border-wait/60 bg-wait/[.08] text-wait' : 'border-line text-soft'}`}>
            <span className="truncate">{level?.label} · {modelLabel} {effort}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none text-muted"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        )}
        <div className="relative flex flex-col gap-1 rounded-[24px] border border-line-hi bg-panel p-1.5 focus-within:border-acid/60">
          <AnimatePresence>{slash.menu}</AnimatePresence>
          <AnimatePresence initial={false}>
            {hint.chip && <motion.div key="chip" {...collapse} className="flex overflow-hidden px-1 pt-1">{hint.chip}</motion.div>}
          </AnimatePresence>
          {props.files.length > 0 && <div className="px-1 pt-1"><AttachmentChips files={props.files} onRemove={props.onRemoveFile} onOpen={props.onOpenFile} /></div>}
          <div className="flex items-end gap-1.5">
            {filePicker}
            <button type="button" onClick={() => picker.current?.click()} aria-label="Allega file"
              className="cc-press flex h-10 w-10 flex-none items-center justify-center rounded-full border border-line text-soft">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </button>
            {field}
            {canSend ? (
              <button type="button" onClick={send} aria-label="Invia" className="cc-press flex h-10 w-10 flex-none items-center justify-center rounded-full bg-acid text-ink"><SendArrow /></button>
            ) : voiceNoteSupported() ? (
              <VoiceNote onSend={props.onVoice} onKeep={(t) => props.setDraft(draftRef.current ? `${draftRef.current} ${t}` : t)} iconSize={18}
                className="cc-press flex h-10 w-10 flex-none items-center justify-center rounded-full bg-acid/15 text-acid"
                stripClassName="rounded-[24px] bg-panel" />
            ) : (
              <button type="button" disabled aria-label="Invia" className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-acid text-ink opacity-40"><SendArrow /></button>
            )}
            {stop('cc-press flex h-10 w-10 flex-none items-center justify-center rounded-full border border-line-hi text-text')}
          </div>
        </div>
        <Sheet open={optionsOpen} onClose={() => setOptionsOpen(false)} label="Opzioni della chat" title="Questa chat">
          <div className="flex flex-col gap-5 pb-2">
            <section className="flex flex-col gap-2">
              <h3 className="m-0 font-mono text-[11.5px] font-medium tracking-wide text-muted uppercase">Autorizzazioni</h3>
              <Segmented label="Livello di autorizzazione" value={chat.permission} columns={2}
                options={PERMISSION_LEVELS.map((l) => ({ key: l.key, label: l.key === 'bypass' ? 'Ignora tutto' : l.key === 'edits' ? 'Modifiche' : l.label, warn: l.key === 'bypass' }))}
                onChange={(v) => { haptic('tap'); void api.setPermission(chat.id, v as PermissionLevel); }} />
              <p className={`m-0 text-[12.5px] leading-snug ${chat.permission === 'bypass' ? 'text-wait' : 'text-muted'}`}><span className="font-medium">{level?.label}</span>: {level?.hint}</p>
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="m-0 font-mono text-[11.5px] font-medium tracking-wide text-muted uppercase">Modello</h3>
              <Segmented label="Modello" value={model} options={MODELS.map((m) => ({ key: m.id, label: m.label.replace(/ [\d.]+$/, '') }))}
                onChange={(v) => { haptic('tap'); props.onModel(v, effort); }} />
            </section>
            <section className="flex flex-col gap-2">
              <h3 className="m-0 font-mono text-[11.5px] font-medium tracking-wide text-muted uppercase">Effort</h3>
              <Segmented label="Effort" value={effort} mono options={EFFORTS.map((x) => ({ key: x, label: x === 'medium' ? 'med' : x }))}
                onChange={(v) => { haptic('tap'); props.onModel(model, v as Effort); }} />
            </section>
            <p className="m-0 text-[12.5px] leading-snug text-muted">Valgono dal prossimo messaggio. Le chat nuove partono da Impostazioni › Chat.</p>
          </div>
        </Sheet>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[880px] px-4 sm:px-6" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
      <div className="relative flex flex-col gap-2 rounded-[14px] border border-line-hi bg-panel p-2.5 focus-within:border-acid/60">
        <AnimatePresence>{slash.menu}</AnimatePresence>
        <AnimatePresence initial={false}>
          {hint.chip && <motion.div key="chip" {...collapse} className="flex overflow-hidden">{hint.chip}</motion.div>}
        </AnimatePresence>
        <AttachmentChips files={props.files} onRemove={props.onRemoveFile} onOpen={props.onOpenFile} />
        {field}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {filePicker}
            <button type="button" onClick={() => picker.current?.click()} aria-label="Allega file" title="Allega file di qualsiasi formato"
              className="cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border border-line text-soft hover:border-line-hi">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l9.2-9.2a3.7 3.7 0 015.2 5.2l-9.2 9.2a1.8 1.8 0 01-2.6-2.6l8.5-8.5" /></svg>
            </button>
            <label className="flex items-center">
              <span className="sr-only">Livello di autorizzazione</span>
              <select value={chat.permission} onChange={(e) => void api.setPermission(chat.id, e.target.value as PermissionLevel)}
                className={`${select} ${chat.permission === 'bypass' ? 'border-wait/60 text-wait' : ''}`}>
                {PERMISSION_LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </label>
            <label className="flex items-center">
              <span className="sr-only">Modello</span>
              <select value={model} onChange={(e) => props.onModel(e.target.value, effort)} className={select}>
                {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </label>
            <label className="flex items-center">
              <span className="sr-only">Effort</span>
              <select value={effort} onChange={(e) => props.onModel(model, e.target.value as Effort)} className={select}>
                {EFFORTS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
          </div>
          <div className="flex items-center gap-1.5">
            {voiceNoteSupported() && (
              <VoiceNote onSend={props.onVoice} onKeep={(t) => props.setDraft(draftRef.current ? `${draftRef.current} ${t}` : t)} iconSize={17}
                className="cc-press flex h-9 w-9 items-center justify-center rounded-[8px] bg-acid/15 text-acid"
                stripClassName="rounded-[14px] bg-panel" />
            )}
            {stop('cc-press flex h-9 w-9 items-center justify-center rounded-[8px] border border-line-hi text-text')}
            <button type="button" onClick={send} disabled={!canSend} aria-label="Invia"
              className="cc-press flex h-9 w-9 items-center justify-center rounded-[8px] bg-acid text-ink disabled:opacity-40">
              <SendArrow />
            </button>
          </div>
        </div>
        <PermissionHint chatId={chat.id} permission={chat.permission} />
      </div>
    </div>
  );
}
