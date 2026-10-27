import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode, type Ref, type RefObject } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { StickToBottom, useStickToBottomContext, type StickToBottomContext } from 'use-stick-to-bottom';
import { pop } from '../motion';
import type { ChatMessage } from '../../../shared/types';

// Contenitore delle conversazioni: ChatContainer e ScrollButton di prompt-kit (prompt-kit.com/docs/chat-container),
// cioè use-stick-to-bottom usata come la intendono i suoi autori, senza nient'altro. Se sei in fondo resti agganciato
// a quello che arriva; ti stacchi scorrendo verso l'alto (rotella, dito, barra, tastiera) e resti dove sei finché non
// torni in fondo. Cambiando chat si rimonta (`key` sulla chat), quindi si riparte in fondo.

/**
 * Quando compare un tuo messaggio nuovo si torna in fondo. Il messaggio arriva dal server dopo l'invio e, sul telefono,
 * mentre la tastiera cambia l'altezza della chat: lo scorrimento chiesto al momento dell'invio da solo non basta,
 * perché quei cambi d'altezza possono staccare la chat dal fondo. Gli altri messaggi seguono le regole di sempre.
 */
export function useBottomOnSend(messages: ChatMessage[], scroller: RefObject<StickToBottomContext | null>) {
  const lastMine = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].id;
    return null;
  }, [messages]);
  const seen = useRef(lastMine);
  useEffect(() => {
    if (lastMine == null || lastMine === seen.current) return;
    seen.current = lastMine;
    // Dopo il disegno del messaggio (due fotogrammi), così il fondo è già quello nuovo.
    requestAnimationFrame(() => requestAnimationFrame(() => { void scroller.current?.scrollToBottom(); }));
  }, [lastMine, scroller]);
}

export type ChatContainerRootProps = {
  children: ReactNode;
  className?: string;
  /** Per scendere in fondo da fuori (all'invio di un messaggio). */
  contextRef?: Ref<StickToBottomContext>;
} & HTMLAttributes<HTMLDivElement>;

export function ChatContainerRoot({ children, className = '', ...props }: ChatContainerRootProps) {
  return (
    <StickToBottom className={`flex overflow-y-auto ${className}`} resize="smooth" initial="instant" role="log" {...props}>
      {children}
    </StickToBottom>
  );
}

export type ChatContainerContentProps = {
  children: ReactNode;
  className?: string;
  /** Classi del riquadro che scorre (la barra di scorrimento di Ciccio, `cc-scroll`). */
  scrollClassName?: string;
} & HTMLAttributes<HTMLDivElement>;

export function ChatContainerContent({ children, className = '', ...props }: ChatContainerContentProps) {
  return (
    <StickToBottom.Content className={`flex w-full flex-col ${className}`} {...props}>
      {children}
    </StickToBottom.Content>
  );
}

/**
 * Pulsante per tornare in fondo (ScrollButton di prompt-kit, nello stile di Ciccio): compare quando non sei in fondo,
 * e diventa «↓ nuovi messaggi» se intanto è arrivato qualcosa. `signal` cambia a ogni novità della chat.
 */
export function ScrollButton({ signal, className = '' }: { signal?: unknown; className?: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const [fresh, setFresh] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!isAtBottom) setFresh(true);
  }, [signal]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (isAtBottom) setFresh(false); }, [isAtBottom]);
  return (
    <AnimatePresence>
      {!isAtBottom && (
        <motion.button key="giu" {...pop} type="button" onClick={() => void scrollToBottom()} aria-label="Torna in fondo"
          className={`cc-press absolute left-1/2 z-10 -translate-x-1/2 rounded-full text-[13px] font-semibold shadow-lg ${fresh ? 'bg-acid px-3.5 py-1.5 text-ink' : 'flex h-9 w-9 items-center justify-center border border-line-hi bg-panel text-soft hover:text-text'} ${className}`}>
          {fresh ? '↓ nuovi messaggi' : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
          )}
        </motion.button>
      )}
    </AnimatePresence>
  );
}
