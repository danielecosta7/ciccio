import { useCallback, useState, type SetStateAction } from 'react';
import type { Attachment } from '../../shared/types';

// Bozze dei messaggi non ancora mandati, una per chat (e una per Ciccio): testo e allegati già caricati.
// In memoria e nel browser, così si ritrovano cambiando chat e anche dopo un ricaricamento.
// Si cancellano all'invio (il campo torna vuoto). Chiavi: «chat:<id>», «agent:<id>» (progetto senza chat), «ciccio».

interface Draft { text: string; atts: Attachment[]; at: number }

const PREFIX = 'ciccio.draft.';
/** Le bozze dimenticate da più di un mese si buttano. */
const MAX_AGE = 30 * 86_400_000;
const mem = new Map<string, Draft>();

function read(key: string): Draft {
  const hit = mem.get(key);
  if (hit) return hit;
  let d: Draft = { text: '', atts: [], at: 0 };
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Draft>;
      d = { text: typeof v.text === 'string' ? v.text : '', atts: Array.isArray(v.atts) ? v.atts : [], at: v.at ?? 0 };
    }
  } catch { /* browser senza memoria: solo in questa pagina */ }
  mem.set(key, d);
  return d;
}

function write(key: string, patch: Partial<Pick<Draft, 'text' | 'atts'>>) {
  const d = { ...read(key), ...patch, at: Date.now() };
  mem.set(key, d);
  try {
    if (!d.text && !d.atts.length) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(d));
  } catch { /* pieno o bloccato: resta in memoria */ }
}

try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    const at = (JSON.parse(localStorage.getItem(k) ?? '{}') as Partial<Draft>).at ?? 0;
    if (Date.now() - at > MAX_AGE) localStorage.removeItem(k);
  }
} catch { /* niente */ }

export const draftFiles = (key: string) => read(key).atts;
export const saveDraftFiles = (key: string, atts: Attachment[]) => write(key, { atts });

/**
 * Testo del campo come useState, ma salvato come bozza della chat `key`: cambiando chat il campo mostra
 * la bozza di quella. Il setter resta legato alla sua chat: un invio fallito dopo un cambio di chat
 * rimette il testo nella bozza giusta, non in quella aperta adesso.
 */
export function useDraft(key: string): [string, (v: SetStateAction<string>) => void] {
  const [slot, setSlot] = useState(() => ({ key, text: read(key).text }));
  const text = slot.key === key ? slot.text : read(key).text;
  const set = useCallback((v: SetStateAction<string>) => {
    const next = typeof v === 'function' ? v(read(key).text) : v;
    write(key, { text: next });
    setSlot({ key, text: next });
  }, [key]);
  return [text, set];
}
