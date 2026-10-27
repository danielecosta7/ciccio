import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { PERMISSION_LEVELS, type PermissionLevel } from '../../shared/types';

/** Spiegazione del livello di autorizzazione: compare per qualche secondo quando lo cambi, poi sparisce. */
export function PermissionHint({ chatId, permission }: { chatId: string; permission: PermissionLevel }) {
  const [shown, setShown] = useState(false);
  const last = useRef({ chatId, permission });
  useEffect(() => {
    const prev = last.current;
    last.current = { chatId, permission };
    // Cambio di chat: niente spiegazione, il livello non l'hai cambiato tu.
    if (prev.chatId !== chatId || prev.permission === permission) { setShown(false); return undefined; }
    setShown(true);
    const t = setTimeout(() => setShown(false), 5000);
    return () => clearTimeout(t);
  }, [chatId, permission]);
  const level = PERMISSION_LEVELS.find((l) => l.key === permission);
  return (
    <AnimatePresence initial={false}>
      {shown && level && (
        <motion.div key={permission} role="status"
          initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto', transition: { duration: 0.22, ease: [0.25, 1, 0.5, 1] } }}
          exit={{ opacity: 0, height: 0, transition: { duration: 0.3 } }} className="overflow-hidden">
          <div className={`px-1 pt-1 text-[12px] leading-snug ${permission === 'bypass' ? 'text-wait' : 'text-muted'}`}>
            <span className="font-medium">{level.label}</span>: {level.hint}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
