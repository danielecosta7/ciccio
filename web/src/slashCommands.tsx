import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { motion } from 'motion/react';
import { quick } from './motion';
import { api } from './api';
import type { SlashCommandView } from '../../shared/types';

/** Fonte dei comandi per la chat con Ciccio (le altre usano l'id del progetto). */
export const CICCIO_COMMANDS = 'ciccio';

// Elenchi già chiesti al server, per fonte: si riusano per un minuto, poi si rileggono (skill nuove).
const FRESH_MS = 60_000;
const lists = new Map<string, { at: number; list: SlashCommandView[] }>();
const loading = new Map<string, Promise<SlashCommandView[]>>();

function load(source: string): Promise<SlashCommandView[]> {
  let p = loading.get(source);
  if (!p) {
    p = (source === CICCIO_COMMANDS ? api.ciccioCommands() : api.commands(source))
      .then((r) => { lists.set(source, { at: Date.now(), list: r.commands }); return r.commands; })
      .finally(() => loading.delete(source));
    loading.set(source, p);
  }
  return p;
}

/** Prima i nomi che cominciano così, poi quelli che lo contengono (anche dopo «plugin:»), poi le descrizioni (da tre lettere). */
function filter(list: SlashCommandView[], q: string): SlashCommandView[] {
  const s = q.toLowerCase();
  if (!s) return list;
  const rank = (c: SlashCommandView) => {
    const n = c.name.toLowerCase();
    if (n.startsWith(s)) return 0;
    if (n.split(/[:\-_]/).some((p) => p.startsWith(s))) return 1;
    if (n.includes(s)) return 2;
    if (s.length >= 3 && c.description.toLowerCase().includes(s)) return 3;
    return -1;
  };
  return list.map((c) => ({ c, r: rank(c) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r).map((x) => x.c);
}

/**
 * Comandi con «/» come in Claude Code: scrivendo «/» a inizio messaggio, o a inizio parola in mezzo al testo, compare
 * l'elenco delle skill e dei comandi della chat, filtrato mentre scrivi. Frecce per scegliere, Invio o Tab per inserire
 * «/nome » al posto della parola (a metà messaggio il server lo porta in testa: hoistCommand in commands.ts),
 * Esc per chiudere; un tocco sul telefono. Invio sul nome già scritto per intero manda il messaggio.
 * `source`: id del progetto, o CICCIO_COMMANDS. `off` lo tiene chiuso (dettatura, messaggio ripreso dalla cronologia).
 */
export function useSlashCommands(opts: {
  source: string;
  value: string;
  setValue: (v: string) => void;
  area: RefObject<HTMLTextAreaElement | null>;
  off?: boolean;
}) {
  const { source, value, setValue, area, off } = opts;
  const id = useId();
  // Dov'è il cursore: il comando è la parola che sta scrivendo, se comincia con «/» (all'inizio o dopo uno spazio).
  const [caret, setCaret] = useState<number | null>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return undefined;
    // Al fotogramma dopo, mai dentro l'evento: un setState durante 'input' fa ridisegnare il campo prima che React
    // legga il testo nuovo, e quello che scrivi sparisce (il campo è controllato da React).
    const update = () => requestAnimationFrame(() => setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null));
    const events = ['input', 'keyup', 'click', 'select', 'focus'] as const;
    events.forEach((t) => el.addEventListener(t, update));
    update();
    return () => events.forEach((t) => el.removeEventListener(t, update));
  }, [area]);
  const pos = caret == null ? -1 : Math.min(caret, value.length);
  const word = pos < 0 ? null : /(^|\s)(\/\S*)$/.exec(value.slice(0, pos));
  const start = word ? pos - word[2].length : -1;
  const end = word ? pos + (/^\S*/.exec(value.slice(pos))?.[0].length ?? 0) : -1;
  const typing = !!word;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const spot = `${start}:${value}`;
  const open = typing && !off && dismissed !== spot;
  const query = word ? word[2].slice(1) : '';

  const [list, setList] = useState<SlashCommandView[] | null>(() => lists.get(source)?.list ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setList(lists.get(source)?.list ?? null); setFailed(false); }, [source]);
  useEffect(() => {
    if (!open) return undefined;
    const hit = lists.get(source);
    if (hit && Date.now() - hit.at < FRESH_MS) { setList(hit.list); return undefined; }
    let alive = true;
    load(source).then((l) => { if (alive) { setList(l); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [open, source]);

  const items = open && list ? filter(list, query) : [];
  const [index, setIndex] = useState(0);
  useEffect(() => { setIndex(0); }, [query, open]);
  useEffect(() => { if (!typing) setDismissed(null); }, [typing]);

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' }); }, [index, open]);

  const pick = (c: SlashCommandView) => {
    const el = area.current;
    // Solo la parola che stavi scrivendo diventa «/nome »; il resto del messaggio resta com'è.
    const inserted = `/${c.name} `;
    const next = `${value.slice(0, start)}${inserted}${value.slice(end).replace(/^ /, '')}`;
    const at = start + inserted.length;
    setValue(next);
    el?.focus();
    requestAnimationFrame(() => { if (el) { el.setSelectionRange(at, at); setCaret(at); } });
  };

  const optionId = (i: number) => `${id}-c${i}`;
  const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

  return {
    /** Da chiamare per primo in onKeyDown: true se ha usato il tasto. */
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!open || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return false;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissed(spot); return true; }
      if (!items.length || e.shiftKey) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setIndex((i) => (i + step + items.length) % items.length);
        return true;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        const c = items[Math.min(index, items.length - 1)];
        // Comando già scritto per intero: Invio lo manda.
        if (e.key === 'Enter' && c.name === query) return false;
        e.preventDefault();
        pick(c);
        return true;
      }
      return false;
    },
    /** Attributi per il campo di testo (lettori di schermo; 1Password non ci propone di salvare niente). */
    inputProps: {
      autoComplete: 'off',
      'data-1p-ignore': true,
      'aria-autocomplete': 'list' as const,
      'aria-expanded': open,
      'aria-controls': open ? `${id}-list` : undefined,
      'aria-activedescendant': open && items.length ? optionId(Math.min(index, items.length - 1)) : undefined,
    },
    /** Elenco sopra il campo: va in un contenitore `relative` che abbraccia il campo, dentro un AnimatePresence. */
    menu: open ? (
      <motion.div key="slash" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: quick }} exit={{ opacity: 0, y: 6, transition: quick }}
        className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-[12px] border border-line-hi bg-panel shadow-[0_8px_24px_rgb(0_0_0/.5)]">
        <div ref={box} id={`${id}-list`} role="listbox" aria-label="Comandi e skill" className="cc-scroll max-h-[min(320px,42vh)] overflow-y-auto overscroll-contain p-1">
          {items.map((c, i) => (
            <button key={c.name} id={optionId(i)} data-i={i} type="button" role="option" aria-selected={i === index} tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()} onMouseMove={() => { if (i !== index) setIndex(i); }} onClick={() => pick(c)}
              className={`flex w-full min-w-0 flex-col gap-0.5 rounded-[8px] px-2.5 py-1.5 text-left ${i === index ? 'bg-panel-hi' : ''} ${touch ? 'min-h-11 justify-center' : ''}`}>
              <span className="flex min-w-0 items-baseline gap-2">
                <span className={`flex-none font-mono text-[13px] ${i === index ? 'text-acid' : 'text-text'}`}>/{c.name}</span>
                {c.hint && <span className="truncate font-mono text-[11.5px] text-muted">{c.hint}</span>}
              </span>
              {c.description && <span className="truncate text-[12.5px] text-muted">{c.description}</span>}
            </button>
          ))}
          {!items.length && (
            <div className="px-2.5 py-2 text-[13px] text-muted">
              {failed ? 'Comandi non disponibili adesso.' : !list ? 'Carico comandi e skill…' : `Nessun comando con «${query}».`}
            </div>
          )}
        </div>
        {!touch && items.length > 0 && (
          <div className="border-t border-line/70 px-3 py-1.5 text-[11.5px] text-muted">↑↓ scegli · Invio o Tab inserisce · Esc chiude</div>
        )}
      </motion.div>
    ) : null,
  };
}
