import { useEffect, useRef, useState, type RefObject } from 'react';
import { haptic } from './haptic';
import { isStandalone } from './viewport';

const EASE = 'cubic-bezier(.25, 1, .5, 1)';
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Swipe dal bordo sinistro per tornare indietro, come nelle app di iPhone: la pagina segue il dito, oltre un terzo
 * dello schermo (o con uno scatto veloce) esce a destra e si torna indietro; altrimenti rientra.
 * Solo nell'app installata: in Safari lo swipe indietro lo fa già il browser e sarebbe doppio.
 */
export function useEdgeSwipeBack(ref: RefObject<HTMLElement | null>, onBack: () => void, enabled: boolean) {
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || !isStandalone()) return undefined;
    let start: { x: number; y: number; t: number } | null = null;
    let dx = 0;
    let dragging = false;
    let armed = false;
    const set = (x: number, animate: boolean) => {
      el.style.transition = animate && !reduced() ? `transform .26s ${EASE}` : 'none';
      el.style.transform = x ? `translateX(${x}px)` : '';
      el.style.boxShadow = x ? '-12px 0 24px rgb(0 0 0 / .5)' : '';
    };
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || t.clientX > 20) return;
      // Con un foglio o la chat di Ciccio aperti sopra la pagina, il bordo non porta indietro.
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="dialog"][aria-label="Chat con Ciccio"]')) return;
      start = { x: t.clientX, y: t.clientY, t: performance.now() };
      dx = 0; dragging = false; armed = false;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      const mx = t.clientX - start.x, my = t.clientY - start.y;
      if (!dragging) {
        // Si decide al primo movimento: di lato è uno swipe indietro, in verticale si lascia scorrere.
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { start = null; return; }
        if (mx < 8) return;
        dragging = true;
      }
      e.preventDefault();
      dx = Math.max(0, mx);
      const past = dx > window.innerWidth / 3;
      if (past !== armed) { armed = past; if (past) haptic('tap'); }
      set(dx, false);
    };
    const onEnd = () => {
      if (!start || !dragging) { start = null; return; }
      const v = dx / Math.max(1, performance.now() - start.t);
      start = null;
      if (dx > window.innerWidth / 3 || v > 0.6) {
        // La pagina resta fuori schermo: l'app la toglie senza rifare l'uscita (ciccio:swiped-back, App.tsx).
        set(window.innerWidth, true);
        setTimeout(() => { window.dispatchEvent(new CustomEvent('ciccio:swiped-back')); back.current(); }, reduced() ? 0 : 200);
      } else set(0, true);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      set(0, false);
    };
  }, [ref, enabled]);
}

/**
 * Trascina per aggiornare sulle pagine che scorrono con la finestra (dashboard, elenco chat): l'app installata non ha
 * il pulsante ricarica. Non ricarica la pagina: chiama `onRefresh` (ricollega e risincronizza). Restituisce quanto
 * è tirata (0-1) e se sta aggiornando, per l'indicatore.
 */
export function usePullToRefresh(onRefresh: () => void, enabled: boolean) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    if (!enabled) return undefined;
    const DIST = 72;
    let startY: number | null = null;
    let p = 0;
    const onStart = (e: TouchEvent) => { startY = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; p = 0; };
    const onMove = (e: TouchEvent) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 0) { if (p) { p = 0; setPull(0); } return; }
      // Resistenza: il dito fa più strada dell'indicatore.
      const next = Math.min(1.2, (dy * 0.5) / DIST);
      if ((next >= 1) !== (p >= 1) && next >= 1) haptic('tap');
      p = next;
      setPull(next);
    };
    const onEnd = () => {
      if (startY == null) return;
      startY = null;
      if (p >= 1) {
        setBusy(true);
        cb.current();
        setTimeout(() => setBusy(false), 900);
      }
      p = 0;
      setPull(0);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [enabled]);
  return { pull, busy };
}
