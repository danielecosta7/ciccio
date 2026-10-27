import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { collapse, pop } from '../motion';
import { api } from '../api';
import { draftFiles, saveDraftFiles } from '../drafts';
import { Image } from './Image';
import type { Attachment } from '../../../shared/types';

// Allegati di un messaggio prima dell'invio: caricati subito nel repo (.ciccio/uploads),
// con la miniatura per le immagini e l'anteprima completa con un clic, per vedere cosa si sta mandando.

export interface PendingFile {
  key: string;
  name: string;
  uploading: boolean;
  att?: Attachment;
  error?: string;
  /** Miniatura locale (immagini), finché la pagina è aperta. */
  thumb?: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
export const isImage = (name: string) => IMAGE.test(name);

/** Le immagini incollate arrivano spesso come «image.png»: un nome con l'ora, così si distinguono. */
function named(f: File, i: number): File {
  if (!/^image\.\w+$/i.test(f.name)) return f;
  const t = new Date();
  const stamp = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
  return new File([f], `incollata-${stamp}${i ? `-${i + 1}` : ''}.${f.name.split('.').pop()}`, { type: f.type, lastModified: f.lastModified });
}

/** File dagli appunti (screenshot, file copiati da Esplora risorse o dal Finder). Vuoto se si incolla solo testo. */
export function pastedFiles(e: ClipboardEvent): File[] {
  const files = Array.from(e.clipboardData.files);
  if (files.length) return files.map(named);
  // Alcuni browser mettono l'immagine solo tra gli elementi degli appunti.
  return Array.from(e.clipboardData.items).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter((f): f is File => !!f).map(named);
}

/** Allegato della bozza salvata: già caricato, la miniatura arriva dal repo. */
function restored(agentId: string, a: Attachment): PendingFile {
  return { key: `bozza-${a.path}`, name: a.name, uploading: false, att: a, thumb: isImage(a.name) ? `/api/agents/${encodeURIComponent(agentId)}/file?path=${encodeURIComponent(a.path)}` : undefined };
}

/**
 * Allegati in attesa di un messaggio, caricati nel repo dell'agente appena aggiunti.
 * Quelli già caricati restano nella bozza della chat `draftKey` (vedi drafts.ts): cambiando chat si ritrovano.
 */
export function useAttachments(agentId: string, draftKey: string) {
  const [slot, setSlot] = useState(() => ({ key: draftKey, files: draftFiles(draftKey).map((a) => restored(agentId, a)) }));
  // Altra chat: i suoi allegati (lo stato si aggiorna subito, durante questo stesso disegno).
  if (slot.key !== draftKey) setSlot({ key: draftKey, files: draftFiles(draftKey).map((a) => restored(agentId, a)) });
  const files = slot.key === draftKey ? slot.files : [];
  const current = useRef(draftKey);
  current.current = draftKey;
  const thumbs = useRef(new Set<string>());
  const release = (list: PendingFile[]) => { for (const f of list) if (f.thumb && thumbs.current.has(f.thumb)) { URL.revokeObjectURL(f.thumb); thumbs.current.delete(f.thumb); } };

  // La bozza segue gli allegati caricati della chat a cui appartengono.
  useEffect(() => { saveDraftFiles(slot.key, slot.files.filter((f) => f.att).map((f) => f.att!)); }, [slot]);
  useEffect(() => () => { for (const u of thumbs.current) URL.revokeObjectURL(u); }, []);

  const clear = useCallback(() => setSlot((s) => { release(s.files); return { ...s, files: [] }; }), []);

  const add = useCallback(async (list: File[]) => {
    if (!list.length) return;
    const key = current.current;
    const pending: PendingFile[] = list.map((f, i) => {
      const thumb = f.type.startsWith('image/') || isImage(f.name) ? URL.createObjectURL(f) : undefined;
      if (thumb) thumbs.current.add(thumb);
      return { key: `${Date.now()}-${i}-${f.name}`, name: f.name, uploading: true, thumb };
    });
    const mine = (s: { key: string }) => s.key === key;
    setSlot((s) => (mine(s) ? { ...s, files: [...s.files, ...pending] } : s));
    try {
      const atts = await api.upload(agentId, list);
      // Se intanto si è cambiata chat, gli allegati finiscono comunque nella bozza della loro.
      if (current.current !== key) { saveDraftFiles(key, [...draftFiles(key), ...atts.filter(Boolean)]); return; }
      setSlot((s) => (mine(s) ? { ...s, files: s.files.map((f) => { const i = pending.findIndex((p) => p.key === f.key); return i >= 0 ? { ...f, uploading: false, att: atts[i] } : f; }) } : s));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSlot((s) => (mine(s) ? { ...s, files: s.files.map((f) => (pending.some((p) => p.key === f.key) ? { ...f, uploading: false, error: msg } : f)) } : s));
    }
  }, [agentId]);

  const remove = useCallback((key: string) => setSlot((s) => { release(s.files.filter((f) => f.key === key)); return { ...s, files: s.files.filter((f) => f.key !== key) }; }), []);

  return {
    files,
    add,
    remove,
    clear,
    uploading: files.some((f) => f.uploading),
    ready: files.filter((f) => f.att).map((f) => f.att!),
  };
}

const ext = (name: string) => name.split('.').pop()?.slice(0, 4) ?? '';

/**
 * Allegati sopra il campo di testo: miniatura per le immagini, formato per gli altri file.
 * Un clic apre l'anteprima completa (immagini, PDF, Word, Excel, testo…) appena il file è caricato.
 */
export function AttachmentChips({ files, onRemove, onOpen }: { files: PendingFile[]; onRemove: (key: string) => void; onOpen?: (path: string) => void }) {
  return (
    <AnimatePresence initial={false}>
    {files.length > 0 && (
    <motion.div key="chips" {...collapse} className="overflow-hidden">
    <div className="flex flex-wrap gap-1.5 px-1 pt-1">
      <AnimatePresence initial={false} mode="popLayout">
        {files.map((f) => {
          const open = f.att && onOpen ? () => onOpen(f.att!.path) : undefined;
          return (
            <motion.span key={f.key} layout {...pop}
              className={`inline-flex items-center gap-2 rounded-[8px] border pr-1 text-[12px] ${f.thumb ? 'h-14 pl-1' : 'h-8 pl-2'} ${f.error ? 'border-block/50 text-[#FFB0A5]' : 'border-line bg-panel-hi'}`}>
              <button type="button" onClick={open} disabled={!open} title={open ? `Anteprima di ${f.name}` : f.name} aria-label={open ? `Anteprima di ${f.name}` : f.name}
                className="flex min-w-0 items-center gap-2 text-left enabled:cursor-zoom-in enabled:hover:text-text">
                {f.thumb
                  ? <img src={f.thumb} alt="" className={`h-12 w-12 flex-none rounded-[6px] border border-line object-cover ${f.uploading ? 'opacity-60' : ''}`} />
                  : <span className="rounded-[3px] bg-line px-1 font-mono text-[10px] uppercase">{ext(f.name)}</span>}
                <span className="flex min-w-0 flex-col">
                  <span className="max-w-[180px] truncate">{f.name}</span>
                  {f.uploading && <span className="text-muted">carico…</span>}
                  {f.error && <span>{f.error}</span>}
                  {open && f.thumb && <span className="text-[11px] text-muted">anteprima</span>}
                </span>
              </button>
              <button type="button" onClick={() => onRemove(f.key)} aria-label={`Togli ${f.name}`} className="px-1 text-[14px] text-muted hover:text-text">×</button>
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
    </motion.div>
    )}
    </AnimatePresence>
  );
}

/**
 * Allegati di un messaggio già mandato: miniatura per le immagini (Image: alta sempre 96px, larga secondo le proporzioni,
 * quindi la chat non cambia altezza mentre arrivano), formato e nome per gli altri file; clic per l'anteprima.
 */
export function SentAttachments({ atts, fileBase, onOpen, align = 'end' }: { atts: Attachment[]; fileBase?: string; onOpen?: (path: string) => void; align?: 'start' | 'end' }) {
  if (!atts.length) return null;
  return (
    <div className={`flex flex-wrap gap-2 ${align === 'end' ? 'justify-end' : ''}`}>
      {atts.map((a) => isImage(a.name) && fileBase ? (
        <Image key={a.path} src={`${fileBase}${encodeURIComponent(a.path)}`} alt={a.name} loading="lazy"
          onOpen={onOpen ? () => onOpen(a.path) : undefined}
          className="h-24 max-w-[220px] min-w-12 rounded-[8px] border border-line hover:border-line-hi" />
      ) : (
        <button key={a.path} type="button" onClick={onOpen ? () => onOpen(a.path) : undefined} disabled={!onOpen} title={`Anteprima di ${a.name}`}
          className="flex h-9 items-center gap-2 rounded-[8px] border border-line bg-panel px-2.5 text-[12px] enabled:hover:border-line-hi">
          <span className="rounded-[3px] bg-line px-1 font-mono text-[10px] uppercase">{ext(a.name)}</span>
          <span className="max-w-[200px] truncate">{a.name}</span>
        </button>
      ))}
    </div>
  );
}
