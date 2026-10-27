import { AnimatePresence, motion } from 'motion/react';
import { quick, smooth } from '../motion';
import { haptic } from '../haptic';
import { AlwaysLabel, ApprovalDetail, alwaysOnly, alwaysRule, approvalParts, toolLabel } from '../ui';
import { onlyPermissions } from '../QuestionPanel';
import type { Approval } from '../../../shared/types';

/**
 * Telefono: il permesso in attesa sta sopra il campo di testo e resta lì finché non decidi, anche se scorri la
 * conversazione. Uno alla volta («1 di 3»), con Consenti, Sempre e Rifiuta su una riga da 44 px. Il dettaglio è
 * intero (scorre se è lungo) e «Sempre» dice la regola che salva.
 */
export function PermissionDock(props: { approvals: Approval[]; onDecide: (id: string, allow: boolean, always?: boolean) => void; className?: string }) {
  const list = onlyPermissions(props.approvals);
  const a = list[0];
  const decide = (allow: boolean, always?: boolean) => { haptic(allow ? 'done' : 'warn'); props.onDecide(a.id, allow, always); };
  const parts = a ? approvalParts(a) : null;
  const rule = a ? alwaysRule(a) : null;
  const twoButtons = a && (!rule || alwaysOnly(a.tool));
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {a && parts && (
        <motion.section key={a.id} aria-label="Permesso da decidere" className={props.className}
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: smooth }} exit={{ opacity: 0, y: 8, scale: 0.98, transition: quick }}>
          <div className="cc-glow flex flex-col gap-2.5 rounded-[16px] border border-wait/60 bg-[oklch(0.17_0.02_75)] p-3.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 flex-none bg-wait" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium tracking-wide text-wait uppercase">Permesso · {toolLabel(a.tool)}</span>
              {list.length > 1 && <span className="flex-none font-mono text-[11.5px] text-muted">1 di {list.length}</span>}
            </div>
            <ApprovalDetail a={a} />
            {parts.reason && <div className="cc-wrap text-[12.5px] leading-snug text-muted">{parts.reason}</div>}
            <div className={`grid gap-1.5 ${twoButtons ? 'grid-cols-2' : 'grid-cols-3'}`}>
              <button type="button" onClick={() => decide(true, alwaysOnly(a.tool))} className="cc-press min-h-11 rounded-[10px] bg-acid px-1 text-[14px] font-semibold text-ink">{alwaysOnly(a.tool) ? 'Consenti sempre' : 'Consenti'}</button>
              {!twoButtons && rule && <button type="button" onClick={() => decide(true, true)} className="cc-press min-h-11 min-w-0 rounded-[10px] border border-line-hi px-1 text-[14px] font-medium"><AlwaysLabel rule={rule} /></button>}
              <button type="button" onClick={() => decide(false)} className="cc-press min-h-11 rounded-[10px] border border-line-hi px-1 text-[14px] font-medium">Rifiuta</button>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
