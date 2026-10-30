import type { KeyboardEvent } from 'react';
import { revealCaret } from './caret';

/**
 * A capo dentro un elenco (Maiusc+Invio, o Invio sul telefono, dove Invio va a capo): aggiunge la voce
 * successiva, e su una voce vuota chiude l'elenco. Invio da solo manda sempre il messaggio.
 * Da chiamare in onKeyDown prima dell'invio: true se ha usato il tasto.
 */
export function listEnter(e: KeyboardEvent<HTMLTextAreaElement>, setValue: (v: string) => void, touch = false): boolean {
  if (e.key !== 'Enter' || !(e.shiftKey || touch) || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey) return false;
  const next = continueList(e.currentTarget);
  if (next == null) return false;
  e.preventDefault();
  setValue(next);
  return true;
}

/** Rientro delle voci: tre spazi (in markdown fino a tre spazi l'elenco resta un elenco). */
const LIST_INDENT = '   ';

/**
 * Testo da inviare: come `trim()`, ma se il messaggio comincia con un elenco rientrato da `listIndent` toglie il rientro
 * a tutte le righe. Il solo `trim()` lo toglierebbe alla prima voce e basta, e le altre diventerebbero un elenco annidato.
 */
export function outgoing(text: string): string {
  const dedent = /^ {1,3}(\d{1,3}[.)]|[-*•]) /.test(text.replace(/^\s*\n/, ''));
  return (dedent ? text.replace(/^ {1,3}/gm, '') : text).trim();
}

/**
 * Elenco appena cominciato: scrivendo «1. » o «- » a inizio riga, la riga rientra un poco dal bordo,
 * così si vede che l'elenco è attivo (le voci successive tengono lo stesso rientro).
 * Da usare in onChange al posto di e.target.value.
 */
export function listIndent(el: HTMLTextAreaElement): string {
  const value = el.value;
  const pos = el.selectionStart;
  if (pos !== el.selectionEnd) return value;
  const start = value.lastIndexOf('\n', pos - 1) + 1;
  if (!/^(\d{1,3}[.)]|[-*•]) $/.test(value.slice(start, pos))) return value;
  const caret = pos + LIST_INDENT.length;
  requestAnimationFrame(() => { el.setSelectionRange(caret, caret); revealCaret(el); });
  return value.slice(0, start) + LIST_INDENT + value.slice(start);
}

/**
 * Elenchi automatici mentre scrivi: andando a capo su "1. voce" arriva "2. ", su "- voce" arriva "- ".
 * Su una voce vuota l'elenco si chiude (il segno sparisce). Restituisce il nuovo testo, o null.
 */
export function continueList(el: HTMLTextAreaElement): string | null {
  const value = el.value;
  const pos = el.selectionStart;
  if (pos !== el.selectionEnd) return null;
  const start = value.lastIndexOf('\n', pos - 1) + 1;
  const line = value.slice(start, pos);
  const num = line.match(/^(\s*)(\d{1,3})([.)])\s+(.*)$/);
  const dot = line.match(/^(\s*)([-*•])\s+(.*)$/);
  if (!num && !dot) return null;
  const content = (num ? num[4] : dot![3]).trim();
  let next: string;
  let caret: number;
  if (!content) {
    // Voce vuota: si esce dall'elenco.
    next = value.slice(0, start) + value.slice(pos);
    caret = start;
  } else {
    const marker = num ? `${num[1]}${Number(num[2]) + 1}${num[3]} ` : `${dot![1]}${dot![2]} `;
    next = `${value.slice(0, pos)}\n${marker}${value.slice(pos)}`;
    caret = pos + 1 + marker.length;
  }
  requestAnimationFrame(() => { el.setSelectionRange(caret, caret); revealCaret(el); });
  return next;
}
