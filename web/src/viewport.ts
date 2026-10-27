import { useSyncExternalStore } from 'react';

/** Fasce di larghezza: telefono sotto i 640 px, tablet fino a 1023, desktop da 1024 (i breakpoint sm e lg di Tailwind). */
export type Band = 'phone' | 'tablet' | 'desktop';

const PHONE = '(max-width: 639.98px)';
const DESKTOP = '(min-width: 1024px)';
const COARSE = '(pointer: coarse)';
/** App installata sulla schermata Home: niente barra di Safari, niente swipe indietro del browser. */
const STANDALONE = '(display-mode: standalone)';

function media(q: string) {
  return typeof matchMedia === 'undefined' ? null : matchMedia(q);
}

function subscribeMedia(cb: () => void) {
  const list = [PHONE, DESKTOP, COARSE].map(media).filter((m): m is MediaQueryList => !!m);
  for (const m of list) m.addEventListener('change', cb);
  return () => { for (const m of list) m.removeEventListener('change', cb); };
}

export function currentBand(): Band {
  if (media(PHONE)?.matches) return 'phone';
  return media(DESKTOP)?.matches ? 'desktop' : 'tablet';
}

/** Fascia attuale, aggiornata quando cambia (rotazione, finestra ridimensionata). */
export function useBand(): Band {
  return useSyncExternalStore(subscribeMedia, currentBand, () => 'desktop');
}

/** Dito invece del mouse: aree di tocco da 44 px, niente comandi che compaiono al passaggio. */
export function useCoarse(): boolean {
  return useSyncExternalStore(subscribeMedia, () => !!media(COARSE)?.matches, () => false);
}

export function isStandalone(): boolean {
  return !!media(STANDALONE)?.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// Tastiera su iPhone: la tastiera va sopra l'app e iOS sposta la parte visibile verso l'alto per mostrare il campo.
// Le pagine con un campo in fondo (chat, Ciccio, fogli) sono un riquadro fisso (classe cc-viewport) che segue la
// parte visibile: --vvtop è quanto iOS l'ha spostata, --vvh quanto è alta. Senza tastiera le due variabili non ci sono.
// Con la tastiera aperta <html> ha data-kb: lì si nasconde quello che non serve mentre scrivi.
//
// Bug di iOS nell'app installata: dopo la tastiera l'altezza dello schermo (innerHeight, 100dvh) può restare più bassa
// del vero, e iOS non disegna niente sotto quella altezza: allungare la pagina non serve, verrebbe tagliata. Si prova
// invece a far rimisurare lo schermo a WebKit (healViewport) dopo la tastiera, ai cambi di pagina e al rientro nell'app.
let keyboard = false;
const kbListeners = new Set<() => void>();
let healer: () => void = () => undefined;

/** Fa rimisurare lo schermo a iOS se è rimasto più basso del vero dopo la tastiera (app installata). */
export function healViewport() { healer(); }

export function installViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  // Altezza piena per larghezza (verticale e orizzontale sono diverse). Solo nell'app installata: in Safari l'altezza
  // cambia davvero quando le barre del browser si riducono, e non è un bug.
  const full = new Map<number, number>();
  const fullHeight = () => {
    const w = window.innerWidth;
    const h = Math.max(full.get(w) ?? 0, window.innerHeight);
    full.set(w, h);
    return h;
  };
  const focused = () => !!document.activeElement?.matches('input, textarea, [contenteditable]');
  const update = () => {
    const fullH = isStandalone() ? fullHeight() : window.innerHeight;
    // Sopra i 120 px di differenza è la tastiera, non la barra di Safari che si riduce. Si confronta con l'altezza piena
    // perché in certe versioni di iOS anche innerHeight si accorcia insieme alla tastiera.
    const kb = focused() && fullH - vv.height > 120;
    if (kb) {
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vvtop', `${Math.round(vv.offsetTop)}px`);
    } else {
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--vvtop');
    }
    if (kb !== keyboard) {
      keyboard = kb;
      if (kb) root.dataset.kb = ''; else delete root.dataset.kb;
      for (const l of kbListeners) l();
    }
  };
  // Elemento alto quanto lo schermo, invisibile: nasconderlo e rimostrarlo con un ricalcolo in mezzo (niente disegno
  // tra i due passi) è il rimedio che altri hanno trovato per far rimisurare lo schermo a WebKit. Lo stesso per i
  // riquadri cc-viewport delle pagine.
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:100dvh;visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);
  healer = () => {
    if (!isStandalone() || focused()) return;
    if (fullHeight() - window.innerHeight <= 4) return;
    const els = [probe, ...document.querySelectorAll<HTMLElement>('.cc-viewport')];
    const scrolled = [...document.querySelectorAll<HTMLElement>('.cc-scroll, [role="log"]')].map((el) => [el, el.scrollTop] as const);
    const y = window.scrollY;
    const before = els.map((el) => el.style.display);
    for (const el of els) el.style.display = 'none';
    void document.body.offsetHeight;
    els.forEach((el, i) => { el.style.display = before[i]; });
    void document.body.offsetHeight;
    for (const [el, top] of scrolled) el.scrollTop = top;
    if (window.scrollY !== y) window.scrollTo(0, y);
    update();
  };
  // La tastiera entra ed esce con un'animazione e iOS non sempre manda l'ultimo resize: per un secondo dopo ogni
  // cambio di fuoco si ricontrolla a ogni fotogramma.
  let until = 0;
  const follow = () => {
    update();
    if (performance.now() < until) requestAnimationFrame(follow);
  };
  const watch = () => { const running = performance.now() < until; until = performance.now() + 1000; if (!running) requestAnimationFrame(follow); };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  document.addEventListener('focusin', watch);
  document.addEventListener('focusout', () => { watch(); for (const t of [160, 500, 1100]) setTimeout(healer, t); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(healer, 300); });
  update();
}

/** Tastiera aperta su un campo di testo. */
export function useKeyboard(): boolean {
  return useSyncExternalStore((cb) => { kbListeners.add(cb); return () => kbListeners.delete(cb); }, () => keyboard, () => false);
}
