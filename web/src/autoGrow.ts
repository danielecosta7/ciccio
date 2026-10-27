import { revealCaret } from './caret';

/**
 * Altezza del campo di testo che segue il testo, fino a `max` px.
 * Per misurare, il campo torna per un attimo a una riga: se il contenitore si accorciava con lui, il
 * riquadro dei messaggi sopra si allungava, il browser riportava lo scorrimento più in su e, tornata
 * l'altezza vera, la chat restava staccata dal fondo di tanto quanto il testo in più. Durante la misura
 * il contenitore resta quindi alto com'era.
 * Anche lo scorrimento interno del campo torna in cima durante la misura: lo si rimette com'era e, se stai
 * scrivendo, si porta in vista il cursore.
 */
export function autoGrow(el: HTMLTextAreaElement, max: number) {
  const box = el.parentElement;
  const scroll = el.scrollTop;
  if (box) box.style.minHeight = `${box.offsetHeight}px`;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  if (box) box.style.minHeight = '';
  el.scrollTop = scroll;
  if (document.activeElement === el) revealCaret(el);
}
