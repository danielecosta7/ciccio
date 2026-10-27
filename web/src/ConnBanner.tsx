import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { ConnState } from './api';

export const CONN: Record<ConnState, { label: string; hint: string; color: string }> = {
  online: { label: 'Server collegato', hint: '', color: '#3DD68C' },
  connecting: { label: 'Mi ricollego…', hint: 'Un attimo, riprendo il collegamento.', color: '#FFB224' },
  offline: { label: 'Sei offline', hint: 'Il telefono non ha rete: riprendo da solo appena torna.', color: 'oklch(0.66 0 0)' },
  server: { label: 'Server non raggiungibile', hint: 'Ciccio non risponde (server spento, o Tailscale scollegato su questo dispositivo): riprovo da solo.', color: '#FF6A55' },
};

/** Avviso in alto su ogni pagina quando il collegamento manca da più di un secondo e mezzo. */
export function ConnBanner({ conn, onRetry }: { conn: ConnState; onRetry: () => void }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (conn === 'online') { setShow(false); return undefined; }
    const t = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(t);
  }, [conn]);
  const c = CONN[conn];
  return (
    <AnimatePresence>
      {show && conn !== 'online' && (
        <motion.div key="conn" role="status" aria-live="polite"
          initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12, transition: { duration: 0.16 } }}
          style={{ top: 'calc(var(--cc-top) + 10px)' }}
          className="fixed inset-x-3 z-[70] flex items-center gap-2.5 rounded-[14px] border border-line-hi bg-panel py-2 pr-2 pl-3.5 text-[13px] shadow-[0_6px_8px_rgb(0_0_0/.45)] sm:inset-x-auto sm:left-1/2 sm:max-w-[calc(100vw-24px)] sm:-translate-x-1/2 sm:rounded-full">
          <span className={conn === 'connecting' ? 'cc-sq-pulse' : ''} style={{ width: 8, height: 8, background: c.color, flex: 'none' }} />
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold">{c.label}</span>
            {/* Sul telefono la spiegazione va a capo invece di tagliarsi. */}
            <span className="text-[12px] leading-snug text-muted sm:truncate">{c.hint}</span>
          </span>
          <button type="button" onClick={onRetry} className="cc-press flex-none rounded-full border border-line px-3 py-1 text-[12.5px] text-soft hover:text-text pointer-coarse:min-h-11 pointer-coarse:px-4">Riprova</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
