import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { pop } from '../motion';

// Fonti nelle risposte: Source di prompt-kit (prompt-kit.com/docs/source). I link al web hanno l'icona di un globo, quelli
// scritti come indirizzo nudo diventano un'etichetta col dominio, e al passaggio del mouse (o col fuoco da tastiera)
// compare l'anteprima: sito, titolo e indirizzo. Al posto della hover card di shadcn una scheda nostra, fuori dal riquadro
// che scorre (così non viene tagliata).

/** Dominio leggibile di un indirizzo (senza www.); vuoto se non è un link http(s). */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : '';
  } catch { return ''; }
}

/**
 * Icona delle fonti: un globo disegnato qui. Niente favicon dal servizio di Google (come in prompt-kit): gli
 * passerebbe ogni dominio citato nelle chat, e la pagina non chiede niente a terzi.
 */
export const SOURCE_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a3a3a3" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>')}`;

/** Risultati di WebSearch (`Links: [{"title":…,"url":…}]`), anche se l'output è stato tagliato a metà. */
export function searchLinks(output: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  for (const m of output.matchAll(/\{"title":("(?:[^"\\]|\\.)*"),"url":("(?:[^"\\]|\\.)*")\}/g)) {
    try { out.push({ title: JSON.parse(m[1]) as string, url: JSON.parse(m[2]) as string }); } catch { /* voce rovinata */ }
  }
  return out;
}

/** Titoli delle pagine trovate dalle ricerche della chat, per indirizzo: l'anteprima mostra il titolo vero. */
export const SourceTitles = createContext<Map<string, string>>(new Map());

export interface SourceInfo { url: string; host: string; title: string }
type Shown = SourceInfo & { rect: DOMRect };

const W = 300;

/** Anteprima di una fonte: si apre con un attimo di ritardo e si chiude appena il puntatore se ne va. */
export function useSourcePreview() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef(0);
  const show = useCallback((el: Element, info: SourceInfo) => {
    window.clearTimeout(timer.current);
    // Link su due righe: la scheda va sotto il primo pezzo.
    timer.current = window.setTimeout(() => setShown({ ...info, rect: el.getClientRects()[0] ?? el.getBoundingClientRect() }), 150);
  }, []);
  const hide = useCallback(() => { window.clearTimeout(timer.current); setShown(null); }, []);
  // Scorrendo la chat la scheda resterebbe ferma mentre il link si sposta: si chiude.
  useEffect(() => {
    if (!shown) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [shown, hide]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const below = shown ? shown.rect.bottom + 130 < window.innerHeight : true;
  const node = createPortal(
    <AnimatePresence>
      {shown && (
        <motion.div key={shown.url} {...pop} role="tooltip" className="pointer-events-none fixed z-50 flex flex-col gap-1.5 rounded-[10px] border border-line-hi bg-panel p-3 shadow-[0_12px_32px_rgb(0_0_0/.55)]"
          style={{ width: W, left: Math.max(8, Math.min(shown.rect.left, window.innerWidth - W - 8)), ...(below ? { top: shown.rect.bottom + 6 } : { bottom: window.innerHeight - shown.rect.top + 6 }) }}>
          <div className="flex min-w-0 items-center gap-1.5">
            <img src={SOURCE_ICON} alt="" width={16} height={16} className="size-4 flex-none rounded-[3px]" />
            <span className="min-w-0 truncate text-[12.5px] text-acid">{shown.host}</span>
          </div>
          {shown.title && <div className="line-clamp-2 text-[13.5px] font-medium leading-snug text-text">{shown.title}</div>}
          <div className="line-clamp-2 break-all font-mono text-[11.5px] text-muted">{shown.url.replace(/^https?:\/\/(www\.)?/, '')}</div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
  return { show, hide, node };
}

/** Etichetta compatta di una fonte: icona e dominio, apre il sito in una scheda nuova. */
export function SourceChip({ url, title }: { url: string; title?: string }) {
  const titles = useContext(SourceTitles);
  const host = hostOf(url);
  const p = useSourcePreview();
  const ref = useRef<HTMLAnchorElement>(null);
  if (!host) return null;
  const info = { url, host, title: title ?? titles.get(url) ?? '' };
  return (
    <>
      <a ref={ref} href={url} target="_blank" rel="noreferrer" aria-label={`${info.title || host} (${host})`}
        onMouseEnter={() => ref.current && p.show(ref.current, info)} onMouseLeave={p.hide}
        onFocus={() => ref.current && p.show(ref.current, info)} onBlur={p.hide}
        className="cc-source-chip inline-flex h-6 max-w-[14rem] items-center gap-1.5 rounded-full border border-line bg-panel-hi py-0 pl-1 pr-2.5 text-[12px] text-soft no-underline transition-colors hover:border-acid/60 hover:text-text">
        <img src={SOURCE_ICON} alt="" width={14} height={14} loading="lazy" className="size-3.5 flex-none rounded-full" />
        <span className="truncate">{host}</span>
      </a>
      {p.node}
    </>
  );
}
