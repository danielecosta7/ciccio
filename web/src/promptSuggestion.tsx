import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';

/**
 * Prossimo messaggio suggerito da Claude a fine giro, come in Claude Code: nel campo vuoto compare in grigio
 * al posto del segnaposto e Tab (o freccia destra) lo mette nel campo. Appena scrivi altro sparisce e non torna.
 * Sul telefono, dove Tab non c'è, è un chip da toccare sopra il campo.
 * `off` lo nasconde (per esempio mentre detti).
 */
export function usePromptSuggestion(opts: {
  suggestion: string | null | undefined;
  value: string;
  setValue: (v: string) => void;
  area: RefObject<HTMLTextAreaElement | null>;
  touch: boolean;
  off?: boolean;
}) {
  const { suggestion, value, setValue, area, touch, off } = opts;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => { if (suggestion && value) setDismissed(suggestion); }, [suggestion, value]);
  const shown = suggestion && !value && !off && dismissed !== suggestion ? suggestion : null;

  const accept = () => {
    const el = area.current;
    if (!shown) return;
    setValue(shown);
    // Il fuoco subito, nel tocco: sul telefono è quello che apre la tastiera.
    el?.focus();
    requestAnimationFrame(() => { if (el) el.setSelectionRange(el.value.length, el.value.length); });
  };

  return {
    /** Testo grigio nel campo vuoto (da usare come placeholder), null se non c'è. */
    ghost: shown && !touch ? shown : null,
    /** Da chiamare per primo in onKeyDown: true se ha usato il tasto. */
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!shown || (e.key !== 'Tab' && e.key !== 'ArrowRight')) return false;
      if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return false;
      e.preventDefault();
      accept();
      return true;
    },
    /** Chip sopra il campo, solo sul telefono. */
    chip: shown && touch ? (
      <button type="button" onClick={accept} aria-label={`Usa il suggerimento: ${shown}`}
        className="cc-press cc-in flex min-h-9 max-w-full items-center gap-1.5 self-start rounded-full border border-line-hi px-3 text-left text-[13px] text-soft">
        <span aria-hidden="true" className="text-acid">↳</span>
        <span className="truncate">{shown}</span>
      </button>
    ) : null,
  };
}
