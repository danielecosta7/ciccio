/**
 * Porta in vista il cursore di un campo di testo che scorre. Il browser lo fa da solo quando scrivi, non quando
 * il testo o il cursore li cambia il codice (la voce successiva di un elenco, un comando con «/», un messaggio
 * ripreso dalla cronologia): il cursore restava sotto il bordo del campo e toccava scorrere a mano.
 * La sua altezza si misura con una copia invisibile del campo, stessi caratteri e stessa larghezza.
 */
export function revealCaret(el: HTMLTextAreaElement) {
  if (el.scrollHeight <= el.clientHeight) return;
  const cs = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'tabSize', 'overflowWrap', 'wordBreak'] as const) {
    mirror.style[p] = cs[p];
  }
  mirror.style.cssText += ';position:absolute;visibility:hidden;top:0;left:-9999px;white-space:pre-wrap;box-sizing:border-box;border:0';
  mirror.style.width = `${el.clientWidth}px`;
  mirror.textContent = el.value.slice(0, el.selectionEnd);
  const mark = document.createElement('span');
  mark.textContent = '​';
  mirror.append(mark);
  document.body.append(mirror);
  const top = mark.offsetTop;
  const bottom = top + (mark.offsetHeight || Number.parseFloat(cs.lineHeight) || 20);
  mirror.remove();
  const pad = Number.parseFloat(cs.paddingBottom) || 0;
  if (bottom + pad > el.scrollTop + el.clientHeight) el.scrollTop = bottom + pad - el.clientHeight;
  else if (top < el.scrollTop) el.scrollTop = Math.max(0, top - (Number.parseFloat(cs.paddingTop) || 0));
}
