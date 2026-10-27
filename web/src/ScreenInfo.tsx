import { useEffect, useState } from 'react';
import { isStandalone } from './viewport';

/** Misura in px di un'altezza CSS (100svh, safe area…) con un elemento invisibile. */
function measure(css: string, prop: 'height' | 'paddingTop' = 'height') {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;top:0;left:0;width:1px;';
  el.style[prop] = css;
  document.body.appendChild(el);
  const v = prop === 'height' ? el.getBoundingClientRect().height : parseFloat(getComputedStyle(el).paddingTop);
  el.remove();
  return Math.round(v);
}

function read() {
  const vv = window.visualViewport;
  return [
    ['App installata', isStandalone() ? 'sì' : 'no'],
    ['Finestra (innerWidth × innerHeight)', `${window.innerWidth} × ${window.innerHeight}`],
    ['Parte visibile (visualViewport)', vv ? `${Math.round(vv.width)} × ${Math.round(vv.height)}, spostata di ${Math.round(vv.offsetTop)}` : '–'],
    ['Schermo (screen)', `${screen.width} × ${screen.height}, densità ${window.devicePixelRatio}`],
    ['100svh / 100dvh / 100lvh', `${measure('100svh')} / ${measure('100dvh')} / ${measure('100lvh')}`],
    ['Safe area alto / basso', `${measure('env(safe-area-inset-top)', 'paddingTop')} / ${measure('env(safe-area-inset-bottom)', 'paddingTop')}`],
    ['Documento (altezza, scorrimento)', `${document.documentElement.scrollHeight}, ${Math.round(window.scrollY)}`],
    ['Tastiera', 'kb' in document.documentElement.dataset ? 'aperta' : 'chiusa'],
  ] as const;
}

/**
 * Misure dello schermo come le vede la pagina, aggiornate dal vivo: servono a capire i problemi di altezza
 * dell'app installata sull'iPhone (fasce vuote, barre spostate), che nel browser del computer non si vedono.
 */
export function ScreenInfo() {
  const [rows, setRows] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setRows(read()), 700);
    return () => clearInterval(t);
  }, []);
  return (
    <dl className="cc-selectable m-0 grid grid-cols-1 gap-x-4 gap-y-2 font-mono text-[12.5px] sm:grid-cols-[auto_1fr]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="m-0 mb-1.5 text-soft sm:mb-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
