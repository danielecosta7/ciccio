import type { ReactNode } from 'react';

// Note di sistema della chat (riavvii, livello di autorizzazione, permessi dati, compressioni…): System message di
// prompt-kit (prompt-kit.com/docs/system-message), un riquadro chiaro con l'icona del tipo invece della riga grigia.
// Il tipo si ricava dal testo, che il server scrive sempre allo stesso modo: vale anche per le note già salvate.

type Tone = 'ok' | 'block' | 'wait' | 'info';

const svg = (d: ReactNode) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICON = {
  check: svg(<path d="M20 6 9 17l-5-5" />),
  cross: svg(<path d="M18 6 6 18M6 6l12 12" />),
  skip: svg(<path d="M4 12h12M12 6l6 6-6 6" />),
  restart: svg(<><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" /></>),
  shield: svg(<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />),
  compress: svg(<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />),
  fresh: svg(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1" /></>),
  stop: svg(<rect x="6" y="6" width="12" height="12" rx="1.5" />),
  key: svg(<><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></>),
  plus: svg(<path d="M12 5v14M5 12h14" />),
  branch: svg(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="12" r="2" /><path d="M6 7v10M6 12h10" /></>),
  info: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>),
};

/** Tipo, icona e testo (senza il simbolo in testa) di una nota. */
export function noteKind(raw: string): { tone: Tone; icon: ReactNode; text: string } {
  const text = raw.replace(/^[✓✗↷↳]\s*/, '');
  if (raw.startsWith('✓')) return { tone: 'ok', icon: ICON.check, text };
  if (raw.startsWith('✗')) return { tone: 'block', icon: ICON.cross, text };
  if (raw.startsWith('↷')) return { tone: 'info', icon: ICON.skip, text };
  if (raw.startsWith('↳')) return { tone: 'info', icon: ICON.branch, text };
  if (/riavviat/i.test(raw)) return { tone: /non riprendo/.test(raw) ? 'wait' : 'info', icon: ICON.restart, text };
  if (/^riprendo/.test(raw)) return { tone: 'info', icon: ICON.restart, text };
  if (/^livello di autorizzazione/.test(raw)) return { tone: 'info', icon: ICON.shield, text };
  if (/compress|comprimo/.test(raw)) return { tone: 'info', icon: ICON.compress, text };
  if (/^nuova (sessione|conversazione)/.test(raw)) return { tone: 'info', icon: ICON.fresh, text };
  if (/^agente fermato/.test(raw)) return { tone: 'wait', icon: ICON.stop, text };
  if (/^SSH:/.test(raw)) return { tone: 'wait', icon: ICON.key, text };
  if (/aggiunt|creata|installato|dominio aperto/.test(raw)) return { tone: 'ok', icon: ICON.plus, text };
  return { tone: 'info', icon: ICON.info, text };
}

const TONE: Record<Tone, string> = {
  ok: 'border-done/30 bg-done/[.05] [--sm-ico:var(--color-done)]',
  block: 'border-block/35 bg-block/[.06] [--sm-ico:var(--color-block)]',
  wait: 'border-wait/35 bg-wait/[.06] [--sm-ico:var(--color-wait)]',
  info: 'border-line bg-panel-hi/40 [--sm-ico:var(--color-muted)]',
};

/** Una nota di sistema: icona del tipo e testo, centrata; `compact` (pannello dell'agente, dentro i passaggi) a sinistra. */
export function SystemMessage({ text, compact = false }: { text: string; compact?: boolean }) {
  const k = noteKind(text);
  return (
    <div role="note" className={`cc-in flex min-w-0 max-w-full items-start gap-2 rounded-[10px] border text-soft ${TONE[k.tone]} ${compact ? 'self-start px-2.5 py-1.5 text-[12px]' : 'self-center px-3 py-2 text-[12.5px]'}`}>
      <span className="flex h-[1lh] flex-none items-center text-[var(--sm-ico)]">{k.icon}</span>
      <span className="cc-wrap min-w-0 leading-normal">{k.text}</span>
    </div>
  );
}
