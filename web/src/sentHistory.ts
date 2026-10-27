import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { ChatMessage } from '../../shared/types';

/** Testi dei messaggi mandati in una chat, dal più vecchio al più recente. */
export const sentTexts = (messages: ChatMessage[]) => messages.filter((m) => m.role === 'user' && m.text.trim()).map((m) => m.text);

/**
 * Freccia su e giù ripropongono i messaggi già mandati, come nel terminale.
 * Su: dalla prima riga del campo (con una bozza, solo a inizio testo, così la prima pressione porta lì il cursore).
 * Giù: dall'ultima riga, verso i più recenti e infine di nuovo la bozza.
 * Restituisce il gestore da chiamare in onKeyDown: true se ha usato il tasto. `browsing` dice se il campo
 * mostra proprio un messaggio ripreso così (per esempio «/compact»: lì le frecce restano alla cronologia).
 */
export function useSentHistory(history: string[], value: string, setValue: (v: string) => void, resetKey?: string) {
  const pos = useRef<number | null>(null); // indice in history; null = si sta scrivendo la bozza
  const draft = useRef('');
  useEffect(() => { pos.current = null; }, [resetKey, history.length]);

  const handler = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return false;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing || !history.length) return false;
    const el = e.currentTarget;
    const at = el.selectionStart;
    if (at !== el.selectionEnd) return false;
    const put = (text: string, caret: 'start' | 'end') => {
      e.preventDefault();
      setValue(text);
      requestAnimationFrame(() => { const c = caret === 'start' ? 0 : el.value.length; el.setSelectionRange(c, c); });
      return true;
    };
    if (e.key === 'ArrowUp') {
      if (value.lastIndexOf('\n', at - 1) !== -1) return false;
      if (pos.current == null && value.trim() && at !== 0) return false;
      if (pos.current === 0) return false;
      if (pos.current == null) { draft.current = value; pos.current = history.length; }
      pos.current -= 1;
      return put(history[pos.current], 'start');
    }
    if (pos.current == null || value.indexOf('\n', at) !== -1) return false;
    pos.current += 1;
    if (pos.current >= history.length) { pos.current = null; return put(draft.current, 'end'); }
    return put(history[pos.current], 'end');
  };
  return Object.assign(handler, { browsing: pos.current != null && history[pos.current] === value });
}
