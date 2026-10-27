import { AnimatePresence, motion } from 'motion/react';
import { pop, smooth } from './motion';
import { haptic } from './haptic';
import { Orb, PixelMark, SettingsIcon } from './ui';

export type Tab = 'agenti' | 'chat' | 'ciccio' | 'impostazioni';
export const TAB_PATH: Record<Tab, string> = { agenti: '/', chat: '/chat', ciccio: '/ciccio', impostazioni: '/impostazioni' };

/** Altezza della barra senza la zona della barra Home; con quella è la variabile CSS --cc-tabbar (styles.css). */
export const TAB_BAR_H = 56;

function Badge({ n, tone }: { n: number; tone: 'wait' | 'acid' }) {
  return (
    <AnimatePresence>
      {n > 0 && (
        <motion.span key="n" {...pop} className={`absolute -top-1 left-1/2 ml-2 flex h-[17px] min-w-[17px] items-center justify-center px-1 font-mono text-[10.5px] font-semibold text-ink ${tone === 'wait' ? 'bg-wait' : 'bg-acid'}`}>{n}</motion.span>
      )}
    </AnimatePresence>
  );
}

/**
 * Barra in basso del telefono: Agenti (con chi ti aspetta), Chat, Ciccio (orb mentre lavora, risposte non lette),
 * Impostazioni. La scheda attiva ha un quadratino acido sopra, come i pallini di stato.
 */
export function TabBar(props: { active: Tab | null; onGo: (tab: Tab) => void; waiting: number; unread: number; ciccioRunning: boolean }) {
  const items: { tab: Tab; label: string; icon: React.ReactNode; badge?: React.ReactNode }[] = [
    {
      tab: 'agenti', label: 'Agenti', badge: <Badge n={props.waiting} tone="wait" />,
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></svg>,
    },
    {
      tab: 'chat', label: 'Chat',
      icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 01-11.6 7.1L4 20l1.1-4.6A8 8 0 1121 12z" /></svg>,
    },
    {
      tab: 'ciccio', label: 'Ciccio', badge: <Badge n={props.unread} tone="acid" />,
      icon: props.ciccioRunning ? <Orb state="solving" size={20} label="Ciccio sta lavorando" /> : <PixelMark size={16} />,
    },
    { tab: 'impostazioni', label: 'Impostazioni', icon: <SettingsIcon size={21} /> },
  ];
  return (
    <nav aria-label="Sezioni" style={{ paddingBottom: 'var(--cc-tabbar-pad)' }}
      className="cc-safe-x fixed inset-x-0 bottom-0 z-30 border-t border-line/80 bg-[oklch(0.145_0_0)]">
      <div className="grid grid-cols-4" style={{ height: TAB_BAR_H }}>
        {items.map((it) => {
          const on = props.active === it.tab;
          return (
            <button key={it.tab} type="button" aria-current={on ? 'page' : undefined}
              onClick={() => { if (!on) haptic('tap'); props.onGo(it.tab); }}
              className={`relative flex flex-col items-center justify-center gap-1 ${on ? 'text-text' : 'text-muted'}`}>
              {on && <motion.span layoutId="tab-mark" transition={smooth} className="absolute top-0 h-[3px] w-6 bg-acid" />}
              <span className={`relative flex h-6 items-center justify-center ${on ? 'text-acid' : ''}`}>{it.icon}{it.badge}</span>
              <span className={`text-[11px] leading-none ${on ? 'font-semibold' : 'font-medium'}`}>{it.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** Indicatore del trascina per aggiornare: l'orb di Ciccio scende dall'alto e si accende quando basta. */
export function PullIndicator({ pull, busy }: { pull: number; busy: boolean }) {
  const shown = busy || pull > 0.05;
  return (
    <div aria-hidden={!busy} role={busy ? 'status' : undefined} aria-label={busy ? 'Aggiorno' : undefined}
      className="pointer-events-none fixed inset-x-0 z-40 flex justify-center" style={{ top: 'calc(var(--cc-top) + 8px)' }}>
      {shown && (
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-line-hi bg-panel shadow-[0_6px_12px_rgb(0_0_0/.45)]"
          style={{ transform: `translateY(${busy ? 12 : Math.min(1, pull) * 12}px) scale(${busy ? 1 : 0.6 + Math.min(1, pull) * 0.4})`, opacity: busy ? 1 : Math.min(1, pull + 0.2) }}>
          <Orb state={busy || pull >= 1 ? 'solving' : 'breathing'} size={20} />
        </span>
      )}
    </div>
  );
}
