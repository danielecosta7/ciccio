import { AnimatePresence, motion } from 'motion/react';
import { Orb, PixelWordmark } from '../ui';
import { Markdown } from '../chat/Markdown';
import { collapse, pop, rise } from '../motion';
import type { ConvState } from './hooks';
import type { OrbState } from 'thinking-orbs';
import type { LiveState } from '../../../shared/types';

const ORB: Record<ConvState, OrbState> = {
  off: 'breathing', starting: 'connecting', listening: 'listening', hearing: 'listening',
  transcribing: 'connecting', thinking: 'solving', speaking: 'weaving',
};

const LABEL: Record<ConvState, string> = {
  off: 'Fermo', starting: 'Accendo il microfono…', listening: 'Ti ascolto', hearing: 'Ti ascolto…',
  transcribing: 'Ti ascolto…', thinking: 'Ci penso…', speaking: 'Ti rispondo',
};

/** Conversazione a voce con Ciccio, a tutto schermo: niente da leggere o scrivere, si parla e basta. */
export function ConversationOverlay(props: {
  open: boolean;
  state: ConvState;
  interim: string;
  said: string;
  reply: string;
  level: number;
  muted: boolean;
  error: string;
  /** Nessun audio dal microfono da qualche secondo. */
  silent?: boolean;
  live?: LiveState;
  onMute: () => void;
  onClose: () => void;
}) {
  const s = props.state;
  const label = s === 'thinking' && props.live?.phase === 'tool' && props.live.tool ? `Uso ${props.live.tool}…` : props.muted ? 'Microfono spento' : LABEL[s];
  return (
    <AnimatePresence>
      {props.open && (
        <motion.div key="conv" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.18 } }}
          role="dialog" aria-label="Conversazione a voce con Ciccio"
          className="cc-safe-top cc-safe-bottom cc-viewport z-[60] flex flex-col bg-ink/[.97] backdrop-blur-sm">
          <div className="flex items-center justify-between px-5 pt-4">
            <PixelWordmark className="text-muted" />
            <span className="font-mono text-[11.5px] text-muted">voce sul tuo server</span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 px-6 text-center">
            {/* L'orb respira con la tua voce: quando parli si ingrandisce un poco. */}
            <motion.div animate={{ scale: s === 'hearing' ? 1 + props.level * 0.35 : 1 }} transition={{ duration: 0.12 }}
              className="flex h-[148px] w-[148px] items-center justify-center rounded-[20px] border border-line bg-panel">
              <Orb state={ORB[s]} size={64} label={label} />
            </motion.div>

            {/* Barre del microfono: si muovono con la tua voce, così vedi subito se l'audio arriva. */}
            <div className="flex h-7 items-end gap-[3px]" aria-hidden="true">
              {[0.55, 0.8, 1, 0.8, 0.55, 0.7, 0.9].map((k, n) => (
                <motion.span key={n} animate={{ height: 4 + Math.min(1, props.muted ? 0 : props.level * k * 1.6) * 24 }} transition={{ duration: 0.08 }}
                  style={{ width: 4, background: props.level > 0.08 && !props.muted ? '#A6FF00' : 'oklch(0.4 0 0)' }} />
              ))}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={label} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                className={`text-[19px] font-semibold tracking-[-0.01em] ${s === 'off' ? 'text-muted' : 'text-acid'}`}>
                {label}
              </motion.div>
            </AnimatePresence>

            <div className="flex w-full max-w-[640px] flex-col gap-5">
              <AnimatePresence initial={false} mode="popLayout">
              {(props.interim || props.said) && (
                <motion.p {...rise} key={props.interim ? 'interim' : props.said}
                  className={`cc-wrap m-0 text-[22px] leading-snug tracking-[-0.01em] ${props.interim ? 'text-soft' : 'text-text'}`}>
                  {props.interim || props.said}
                </motion.p>
              )}
              </AnimatePresence>
              <AnimatePresence initial={false}>
              {props.reply && (
                <motion.div key="reply" {...rise} className="cc-scroll cc-live max-h-[32vh] overflow-y-auto text-left text-[15.5px] leading-relaxed text-soft">
                  <Markdown text={props.reply} />
                </motion.div>
              )}
              {props.error && <motion.div key="error" {...pop} className="text-[14px] text-block">{props.error}</motion.div>}
              {props.silent && !props.muted && !props.error && (
                <motion.div key="silent" {...collapse} className="overflow-hidden">
                  <div className="cc-wrap rounded-[10px] border border-wait/45 bg-wait/[.06] px-3 py-2 text-[13.5px] leading-snug text-soft">
                    Non mi arriva audio dal microfono. Controlla che il browser abbia il permesso del microfono e che sia scelto quello giusto; su iPhone, che nessun'altra app lo stia usando. Poi premi «Fine» e riprova.
                  </div>
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          </div>

          <div className="flex items-center justify-center gap-4 px-6 pt-4 pb-8">
            <button type="button" onClick={props.onMute} aria-pressed={props.muted} aria-label={props.muted ? 'Riaccendi il microfono' : 'Spegni il microfono'}
              className={`cc-press flex h-16 w-16 items-center justify-center rounded-full border ${props.muted ? 'border-block/60 bg-block/15 text-block' : 'border-line-hi bg-panel text-text'}`}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="2.5" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3.5" />
                {props.muted && <path d="M3 3l18 18" />}
              </svg>
            </button>
            <button type="button" onClick={props.onClose} aria-label="Chiudi la conversazione"
              className="cc-press flex h-16 min-w-[128px] items-center justify-center rounded-full bg-acid px-7 text-[16px] font-semibold text-ink">
              Fine
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
