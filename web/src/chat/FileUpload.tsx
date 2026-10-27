import { useEffect, useId, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { quick } from '../motion';

// File trascinati sulle chat: FileUpload di prompt-kit (prompt-kit.com/docs/file-upload), senza shadcn.
// Come lì, si ascolta tutta la finestra e compare un riquadro a tutto schermo; in più ogni chat aperta (pagina della
// chat, pannello dell'agente, chat di Ciccio) è una zona, e il riquadro dice dove finiscono i file: la zona sotto il
// puntatore (la più piccola, così la chat di Ciccio sopra una pagina vince) oppure, fuori da tutte, la chat aperta.
// Si guarda solo un trascinamento di file che arriva da fuori: testo, link e immagini trascinati dentro la pagina
// restano al browser, e dove non c'è una chat aperta non si tocca niente.

export interface FileDropZone {
  /** Dove finiscono i file, per il riquadro: «a lightroom · Nuova chat». */
  to: string;
  /** File rilasciati; senza, la zona li rifiuta e il riquadro dice `refuse` (la chat di Ciccio non ha allegati). */
  onFiles?: (files: File[]) => void;
  refuse?: string;
  /** Riceve i file rilasciati fuori da tutte le zone (la chat aperta della pagina). */
  fallback?: boolean;
  disabled?: boolean;
}

interface Zone { id: string; el: RefObject<HTMLElement | null>; opts: RefObject<FileDropZone> }

interface DropState { zone: string | null; rect: DOMRect | null }

const zones: Zone[] = [];
let state: DropState = { zone: null, rect: null };
const listeners = new Set<() => void>();
const set = (next: DropState) => {
  if (next.zone === state.zone && next.rect?.x === state.rect?.x && next.rect?.y === state.rect?.y && next.rect?.width === state.rect?.width && next.rect?.height === state.rect?.height) return;
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Zona che riceve un rilascio nel punto (x, y), con il suo riquadro sullo schermo. */
function pick(x: number, y: number): { zone: Zone; rect: DOMRect } | null {
  let best: { zone: Zone; rect: DOMRect } | null = null;
  for (const z of zones) {
    const rect = z.el.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height || z.opts.current.disabled) continue;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
    if (!best || rect.width * rect.height < best.rect.width * best.rect.height) best = { zone: z, rect };
  }
  if (best) return best;
  // Fuori da tutte: la chat aperta più recente (pannello dell'agente sopra la dashboard).
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    const rect = z.el.current?.getBoundingClientRect();
    if (rect?.width && rect.height && z.opts.current.fallback && !z.opts.current.disabled) return { zone: z, rect };
  }
  return null;
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

// Un trascinamento nato nella pagina (un'immagine della chat, del testo selezionato) non è un allegato.
let inside = false;
let leaveTimer = 0;
const end = () => { window.clearTimeout(leaveTimer); set({ zone: null, rect: null }); };

function onDragStart() { inside = true; }
function onDragEnd() { inside = false; end(); }

function onDragOver(e: DragEvent) {
  if (inside || !hasFiles(e)) return;
  window.clearTimeout(leaveTimer);
  const hit = pick(e.clientX, e.clientY);
  if (!hit) { end(); return; }
  // Annullare dragover è quello che permette il rilascio (e impedisce al browser di aprire il file al posto della pagina).
  e.preventDefault();
  // Sulla zona che rifiuta il rilascio non avviene: il browser chiude con un dragleave senza elemento d'arrivo.
  if (e.dataTransfer) e.dataTransfer.dropEffect = hit.zone.opts.current.onFiles ? 'copy' : 'none';
  set({ zone: hit.zone.id, rect: hit.rect });
}

function onDragLeave(e: DragEvent) {
  if (inside || !hasFiles(e)) return;
  // Senza elemento d'arrivo si è usciti dalla finestra; alcuni browser lo dicono anche passando da un elemento all'altro,
  // quindi si aspetta un attimo: se arriva un altro dragover il riquadro resta.
  if (!e.relatedTarget) { window.clearTimeout(leaveTimer); leaveTimer = window.setTimeout(end, 120); }
}

function onDrop(e: DragEvent) {
  if (inside) { inside = false; end(); return; }
  const hit = hasFiles(e) ? pick(e.clientX, e.clientY) : null;
  end();
  if (!hit) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) hit.zone.opts.current.onFiles?.(files);
}

function onBlur() { inside = false; end(); }

const HANDLERS = [['dragstart', onDragStart], ['dragend', onDragEnd], ['dragenter', onDragOver], ['dragover', onDragOver], ['dragleave', onDragLeave], ['drop', onDrop], ['blur', onBlur]] as const;
function listen(on: boolean) {
  for (const [type, fn] of HANDLERS) {
    if (on) window.addEventListener(type, fn as EventListener);
    else window.removeEventListener(type, fn as EventListener);
  }
}

/**
 * Rende `el` una zona di rilascio dei file (vedi sopra). Restituisce il riquadro da mettere nella pagina:
 * compare, in un portal sopra tutto, quando i file trascinati finirebbero in questa zona.
 */
export function useFileDrop(el: RefObject<HTMLElement | null>, opts: FileDropZone) {
  const id = useId();
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    zones.push({ id, el, opts: latest });
    if (zones.length === 1) listen(true);
    return () => {
      zones.splice(zones.findIndex((z) => z.id === id), 1);
      if (!zones.length) listen(false);
      if (state.zone === id) end();
    };
  }, [id, el]);
  const s = useSyncExternalStore(subscribe, () => state);
  const active = s.zone === id && s.rect ? s.rect : null;
  return createPortal(<FileUploadContent rect={active} opts={opts} />, document.body);
}

/** Il riquadro a tutto schermo: fondo scuro su tutta la finestra e, sopra la zona che riceve, il bordo tratteggiato. */
function FileUploadContent({ rect, opts }: { rect: DOMRect | null; opts: FileDropZone }) {
  const ok = !!opts.onFiles;
  // Il riquadro sta dentro la zona con un margine, e mai più piccolo di una scheda leggibile.
  const box = rect && {
    left: rect.left + 12,
    top: rect.top + 12,
    width: Math.max(rect.width - 24, 220),
    height: Math.max(rect.height - 24, 140),
  };
  return (
    <AnimatePresence>
      {box && (
        <motion.div key="drop" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: quick }} exit={{ opacity: 0, transition: { duration: 0.12 } }}
          aria-hidden="true" className="pointer-events-none fixed inset-0 z-[80] bg-ink/70 backdrop-blur-[2px]">
          <motion.div initial={{ ...box, scale: 0.985 }} animate={{ ...box, scale: 1 }} transition={quick}
            className={`absolute flex flex-col items-center justify-center gap-2 rounded-[14px] border-2 border-dashed px-6 text-center ${ok ? 'border-acid bg-acid/[.04] text-acid' : 'border-line-hi bg-panel/60 text-soft'}`}>
            {ok ? (
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M7 9l5-5 5 5" /><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" /></svg>
            ) : (
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M6 18L18 6" /></svg>
            )}
            <span className="text-[16px] font-semibold">{ok ? 'Rilascia per allegare' : opts.refuse ?? 'Qui non si allegano file'}</span>
            <span className="max-w-[420px] truncate text-[13px] text-soft">{ok ? `${opts.to} · qualsiasi formato` : opts.to}</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
