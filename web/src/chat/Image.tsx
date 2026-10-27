import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ImgHTMLAttributes } from 'react';

// Immagini delle chat: Image di prompt-kit (prompt-kit.com/docs/image), senza shadcn. Come lì accetta anche i byte
// (base64 o Uint8Array) oltre all'indirizzo; in più ha il segnaposto che pulsa mentre carica, l'immagine che compare
// in dissolvenza, un riquadro se non si carica, e riserva lo spazio con le proporzioni quando le conosce.
// Le proporzioni di ogni immagine già vista restano nel browser (sizes più sotto): riaprendo una chat le immagini
// tengono il loro posto dal primo fotogramma e la conversazione non salta mentre arrivano.

export type GeneratedImageLike = {
  base64?: string;
  uint8Array?: Uint8Array;
  mediaType?: string;
};

type Size = [w: number, h: number];

const KEY = 'ciccio.imgSizes';
const MAX = 400;
let sizes: Map<string, Size> | null = null;

function table(): Map<string, Size> {
  if (sizes) return sizes;
  sizes = new Map();
  try { for (const [k, v] of JSON.parse(localStorage.getItem(KEY) ?? '[]') as [string, Size][]) sizes.set(k, v); } catch { /* memoria del browser non disponibile */ }
  return sizes;
}

/** Larghezza e altezza naturali di un'immagine già vista, se le conosciamo. */
export function knownSize(src: string): Size | undefined {
  return table().get(src);
}

/** Ricorda le misure di un'immagine caricata (solo indirizzi veri: data: e blob: valgono per questa pagina). */
export function rememberSize(src: string, w: number, h: number) {
  if (!src || !w || !h) return;
  const t = table();
  const old = t.get(src);
  if (old && old[0] === w && old[1] === h) return;
  t.delete(src);
  t.set(src, [w, h]);
  if (/^(data|blob):/.test(src)) return;
  while (t.size > MAX) t.delete(t.keys().next().value!);
  try { localStorage.setItem(KEY, JSON.stringify([...t].filter(([k]) => !/^(data|blob):/.test(k)))); } catch { /* memoria piena o non disponibile */ }
}

export type ImageProps = GeneratedImageLike & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onClick'> & {
  src?: string;
  alt: string;
  /** Classi del riquadro (misure, angoli, bordo). */
  className?: string;
  /** Proporzioni (larghezza / altezza) se si sanno già; altrimenti quelle ricordate, poi quelle vere. */
  ratio?: number;
  /** Proporzioni del segnaposto quando non si sanno (immagine mai vista). */
  placeholderRatio?: number;
  fit?: 'cover' | 'contain';
  /** Clic: anteprima grande. */
  onOpen?: () => void;
  title?: string;
};

export function Image({ src: url, base64, uint8Array, mediaType = 'image/png', alt, className = '', ratio, placeholderRatio = 1, fit = 'cover', onOpen, title, style, ...props }: ImageProps) {
  const [objectUrl, setObjectUrl] = useState<string>();
  useEffect(() => {
    if (!uint8Array) { setObjectUrl(undefined); return undefined; }
    const u = URL.createObjectURL(new Blob([uint8Array as BlobPart], { type: mediaType }));
    setObjectUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [uint8Array, mediaType]);
  const src = url ?? (base64 ? `data:${mediaType};base64,${base64}` : objectUrl);

  // Già vista: quasi sempre nella cache del browser, niente segnaposto né dissolvenza.
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(() => (src && knownSize(src) ? 'ready' : 'loading'));
  const [natural, setNatural] = useState<Size | undefined>(() => (src ? knownSize(src) : undefined));
  const img = useRef<HTMLImageElement>(null);
  // Altra immagine: di nuovo il segnaposto, a meno che sia già nella cache del browser (niente lampo).
  useLayoutEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth) { setState('ready'); setNatural([el.naturalWidth, el.naturalHeight]); }
    else { const known = src ? knownSize(src) : undefined; setState(known ? 'ready' : 'loading'); setNatural(known); }
  }, [src]);

  const r = ratio ?? (natural ? natural[0] / natural[1] : undefined);
  const box: CSSProperties = { aspectRatio: r ?? placeholderRatio, ...style };
  const body = (
    <span data-state={state} className={`cc-img relative block overflow-hidden ${className}`} style={box}>
      {src && (
        <img ref={img} src={src} alt={alt} decoding="async" {...props}
          onLoad={(e) => { const el = e.currentTarget; rememberSize(src, el.naturalWidth, el.naturalHeight); setNatural([el.naturalWidth, el.naturalHeight]); setState('ready'); }}
          onError={() => setState('error')}
          className={`h-full w-full ${fit === 'cover' ? 'object-cover' : 'object-contain'}`} />
      )}
      {state === 'error' && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center text-[11.5px] text-muted">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 16l5-5 4 4 3-3 6 6M4 4l16 16" /></svg>
          <span className="line-clamp-2">Immagine non disponibile</span>
        </span>
      )}
    </span>
  );
  if (!onOpen) return body;
  return (
    <button type="button" onClick={onOpen} title={title ?? `Anteprima di ${alt}`} aria-label={title ?? `Anteprima di ${alt}`}
      className="cc-press block flex-none cursor-zoom-in rounded-[8px] text-left">
      {body}
    </button>
  );
}
