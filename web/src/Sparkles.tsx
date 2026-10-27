import { useEffect, useRef, useState } from 'react';

interface Spark { id: number; x: number; y: number }

/**
 * Puntini verde acido che si accendono ogni tanto sulla griglia di puntini dello sfondo (cc-dots:
 * passo 10 px, allineata in alto a destra). Pochi alla volta, mai sopra il testo in modo invadente.
 */
export function Sparkles({ every = 900, max = 6 }: { every?: number; max?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const next = useRef(0);

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const el = box.current;
      if (el && document.visibilityState === 'visible') {
        const w = el.clientWidth, h = el.clientHeight;
        const cols = Math.floor(w / 10), rows = Math.floor(h / 10);
        if (cols > 0 && rows > 0) {
          // Centro di una cella della griglia, contando da destra come lo sfondo.
          const x = w - (Math.floor(Math.random() * cols) * 10 + 5);
          const y = Math.floor(Math.random() * rows) * 10 + 5;
          const id = ++next.current;
          setSparks((s) => [...s.slice(-(max - 1)), { id, x, y }]);
          setTimeout(() => setSparks((s) => s.filter((p) => p.id !== id)), 2800);
        }
      }
      timer = setTimeout(tick, every * (0.6 + Math.random() * 0.8));
    };
    timer = setTimeout(tick, every);
    return () => clearTimeout(timer);
  }, [every, max]);

  return (
    <div ref={box} aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
      {sparks.map((p) => <span key={p.id} className="cc-spark" style={{ left: p.x - 1.5, top: p.y - 1.5 }} />)}
    </div>
  );
}
