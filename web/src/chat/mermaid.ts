// Diagrammi Mermaid (file .mmd e blocchi ```mermaid): libreria caricata solo quando ne arriva uno.
type Mermaid = (typeof import('mermaid'))['default'];
let lib: Promise<Mermaid> | null = null;
let n = 0;

export async function renderMermaid(code: string): Promise<string> {
  lib ??= import('mermaid').then(({ default: m }) => {
    m.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', fontFamily: 'Geist, system-ui, sans-serif' });
    return m;
  });
  const m = await lib;
  const { svg } = await m.render(`cc-mermaid-${++n}`, code);
  return svg;
}
