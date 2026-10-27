import { useState } from 'react';

const COPY_PATH = <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>;
const DONE_PATH = <path d="M20 6 9 17l-5-5" />;

/** Pulsante «copia» piccolo, come sotto le risposte nella app di Claude: per un attimo diventa una spunta. */
export function CopyButton({ copy, label = 'Copia', className = '' }: { copy: () => Promise<void>; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const [err, setErr] = useState('');
  const click = () => {
    copy().then(() => setState('done'), (e: unknown) => { setErr(e instanceof Error ? e.message : String(e)); setState('error'); })
      .finally(() => window.setTimeout(() => setState('idle'), 1500));
  };
  return (
    <button type="button" onClick={click} aria-label={label} title={state === 'error' ? `Copia non riuscita: ${err}` : state === 'done' ? 'Copiato' : label}
      className={`flex flex-none items-center justify-center ${state === 'done' ? 'text-acid' : state === 'error' ? 'text-block' : 'text-muted hover:text-text'} ${className}`}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={state === 'done' ? 2.6 : 2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{state === 'done' ? DONE_PATH : COPY_PATH}</svg>
    </button>
  );
}
