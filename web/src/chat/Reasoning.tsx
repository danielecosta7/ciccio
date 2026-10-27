import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Disclosure } from '@heroui/react';
import { Markdown } from './Markdown';

// Ragionamento e testo che luccica: Reasoning, TextShimmer e ThinkingBar di prompt-kit (prompt-kit.com/docs),
// rifatti con il Disclosure di HeroUI e i colori di Ciccio.

/** Testo che luccica mentre l'agente lavora (TextShimmer). Con «riduci movimento» resta fermo, leggibile. */
export function TextShimmer({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`cc-shimmer ${className}`}>{children}</span>;
}

const BULB = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
    <path d="M9 18h6M10 21.5h4M12 2.5a6.5 6.5 0 00-3.8 11.8c.6.5.8 1.1.8 1.8V17h6v-.9c0-.7.3-1.3.8-1.8A6.5 6.5 0 0012 2.5z" />
  </svg>
);

/** Prima riga leggibile del ragionamento, per il blocco chiuso. */
function firstLine(text: string) {
  return text.split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) ?? '';
}

/**
 * Il ragionamento del modello (il riassunto che manda l'API): aperto mentre scorre, si chiude da solo quando il
 * pensiero finisce e si riapre con un clic, come in Claude. Mentre scorre mostra solo le ultime righe in un riquadro
 * di altezza fissa, così la chat non si allunga e non salta quando si chiude.
 */
export function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  const was = useRef(streaming);
  useEffect(() => {
    if (streaming !== was.current) setOpen(streaming);
    was.current = streaming;
  }, [streaming]);
  // Sfumatura in alto solo quando le righe non ci stanno più nel riquadro.
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    if (!streaming || !box.current || !inner.current) return;
    const el = inner.current, outer = box.current;
    const ro = new ResizeObserver(() => setOver(el.offsetHeight > outer.clientHeight + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [streaming]);
  const line = firstLine(text);
  return (
    <Disclosure isExpanded={open} onExpandedChange={setOpen} className="cc-in min-w-0">
      <Disclosure.Trigger aria-label={open ? 'Chiudi il ragionamento' : 'Apri il ragionamento'}
        className="flex w-full min-w-0 items-center gap-2 rounded-[6px] py-1 text-left text-[13px] text-muted hover:text-soft">
        {BULB}
        {streaming ? <TextShimmer className="flex-none font-medium">Ragionamento</TextShimmer> : <span className="flex-none font-medium text-soft">Ragionamento</span>}
        <Disclosure.Indicator className="ms-0 size-3.5 text-muted" />
        {!open && line && <span className="min-w-0 flex-1 truncate">{line}</span>}
      </Disclosure.Trigger>
      <Disclosure.Content>
        <div ref={box} className={`ml-[6px] mt-1 border-l-2 border-line pl-3.5 text-[13px] leading-relaxed text-muted [&_.cc-md_strong]:text-soft ${streaming ? `cc-think-live ${over ? 'cc-think-fade' : ''}` : 'cc-scroll max-h-[360px] overflow-y-auto'}`}>
          <div ref={inner}><Markdown text={text} /></div>
        </div>
      </Disclosure.Content>
    </Disclosure>
  );
}
