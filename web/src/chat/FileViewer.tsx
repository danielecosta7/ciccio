import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { api, fileBaseOf } from '../api';
import { Markdown, cleanHtml } from './Markdown';
import { highlightLines, langFor } from './highlight';
import { renderMermaid } from './mermaid';
import { ModelView } from './ModelView';
import { CopyButton } from './CopyButton';
import { canCopy, copyFile } from './fileActions';
import { quick, rise } from '../motion';

/**
 * Anteprima dei file del repo, come nella app desktop di Claude: ogni file com'è davvero. Immagini, PDF, video, audio,
 * pagine HTML vive; Excel e Word letti qui (o nel visore di Office online, se acceso nelle Impostazioni); modelli 3D da
 * girare; Markdown e diagrammi Mermaid disegnati, codice colorato, CSV come tabelle, notebook Jupyter.
 */

type Kind = 'image' | 'pdf' | 'video' | 'audio' | 'table' | 'office' | 'model' | 'html' | 'markdown' | 'mermaid' | 'notebook' | 'json' | 'code' | 'other';

const KIND: [RegExp, Kind][] = [
  [/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i, 'image'],
  [/\.pdf$/i, 'pdf'],
  [/\.(mp4|webm|mov|m4v)$/i, 'video'],
  [/\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)$/i, 'audio'],
  [/\.(csv|tsv)$/i, 'table'],
  [/\.(docx?|xlsx?|xlsm|pptx?|odt|ods|odp)$/i, 'office'],
  [/\.(stl|obj|3mf)$/i, 'model'],
  [/\.html?$/i, 'html'],
  [/\.(md|markdown|mdx)$/i, 'markdown'],
  [/\.(mmd|mermaid)$/i, 'mermaid'],
  [/\.ipynb$/i, 'notebook'],
  [/\.(json|jsonc|geojson|webmanifest)$/i, 'json'],
  [/\.(txt|text|log|ts|tsx|mts|cts|js|jsx|mjs|cjs|ya?ml|toml|ini|env|conf|cfg|css|scss|less|xml|py|rb|go|rs|java|kt|swift|php|pl|lua|r|sh|bash|zsh|ps1|sql|c|h|cpp|hpp|cc|cs|vue|svelte|astro|lock|gitignore|graphql|gql|diff|patch|srt|vtt|properties|gradle)$|(^|\/)(Dockerfile[^/]*|Makefile|README|LICENSE|CHANGELOG|\.env[^/]*)$/i, 'code'],
];

export function kindOf(path: string): Kind {
  return KIND.find(([re]) => re.test(path))?.[1] ?? 'other';
}

/** Formati con due viste: quella disegnata e il sorgente. */
const HAS_SOURCE = new Set<Kind>(['html', 'markdown', 'mermaid', 'notebook', 'image']);
const TEXT_KINDS = new Set<Kind>(['table', 'markdown', 'mermaid', 'notebook', 'json', 'code']);

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function useFetched<T>(url: string | null, read: (r: Response) => Promise<T>, max = 2_000_000): { data: T | null; err: string } {
  const [state, setState] = useState<{ data: T | null; err: string }>({ data: null, err: '' });
  useEffect(() => {
    setState({ data: null, err: '' });
    if (!url) return;
    let alive = true;
    fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(r.status === 404 ? 'File non trovato: forse è stato spostato o cancellato.' : `Errore ${r.status}`);
      if (Number(r.headers.get('content-length') ?? 0) > max) throw new Error('File troppo grande per l’anteprima: scaricalo.');
      const data = await read(r);
      if (alive) setState({ data, err: '' });
    }).catch((e) => alive && setState({ data: null, err: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Loading() {
  return <div className="text-[13px] text-muted">Preparo l’anteprima…</div>;
}

export function CodeView({ text, path }: { text: string; path: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    void highlightLines(text, langFor(path)).then((l) => alive && setLines(l));
    return () => { alive = false; };
  }, [text, path]);
  const shown = (lines ?? []).slice(0, 5000);
  return (
    <pre className="cc-code m-0 font-mono text-[12px] leading-relaxed text-soft">
      {shown.map((l, i) => (
        <div key={i} className="flex">
          <span className="w-10 flex-none select-none pr-3 text-right text-muted/60">{i + 1}</span>
          <span className="min-w-0 whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: l || ' ' }} />
        </div>
      ))}
      {lines && lines.length > shown.length && <div className="pt-2 text-muted">… altre {lines.length - shown.length} righe: scarica il file per vederlo tutto.</div>}
    </pre>
  );
}

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function Table({ rows, total }: { rows: string[][]; total?: number }) {
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full table-fixed border-collapse font-mono text-[12px]">
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i === 0 ? 'bg-panel-hi text-muted' : 'border-t border-line/60'}>
              {r.map((c, j) => <td key={j} className="cc-wrap px-2 py-1 align-top">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {total != null && total > rows.length && <div className="text-[12px] text-muted">Mostro le prime {rows.length} righe di {total}.</div>}
    </div>
  );
}

function SheetView({ url }: { url: string }) {
  const { data, err } = useFetched(url, async (r) => {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    return readXlsxFile(await r.blob());
  }, 20_000_000);
  const [tab, setTab] = useState(0);
  if (err) return <div className="text-[13px] text-block">{err}</div>;
  if (!data) return <Loading />;
  const sheet = data[Math.min(tab, data.length - 1)];
  const cell = (v: unknown) => (v == null ? '' : v instanceof Date ? v.toLocaleDateString('it-IT') : String(v));
  return (
    <div className="flex flex-col gap-2.5">
      {data.length > 1 && (
        <div role="tablist" aria-label="Fogli" className="flex flex-wrap gap-1">
          {data.map((s, i) => (
            <button key={s.sheet} type="button" role="tab" aria-selected={i === tab} onClick={() => setTab(i)}
              className={`min-h-8 rounded-[8px] px-2.5 text-[12.5px] ${i === tab ? 'bg-acid text-ink' : 'border border-line text-soft hover:border-line-hi'}`}>{s.sheet}</button>
          ))}
        </div>
      )}
      {sheet && sheet.data.length ? <Table rows={sheet.data.slice(0, 500).map((r) => r.slice(0, 40).map(cell))} total={sheet.data.length} /> : <div className="text-[13px] text-muted">Foglio vuoto.</div>}
    </div>
  );
}

function DocxView({ url }: { url: string }) {
  const { data, err } = useFetched(url, async (r) => {
    const { default: mammoth } = await import('mammoth/mammoth.browser.js');
    const res = await mammoth.convertToHtml({ arrayBuffer: await r.arrayBuffer() });
    return cleanHtml(res.value);
  }, 30_000_000);
  if (err) return <div className="text-[13px] text-block">{err}</div>;
  if (data == null) return <Loading />;
  return <div className="cc-md cc-doc rounded-[10px] border border-line bg-[oklch(0.17_0_0)] p-5 text-[14px] leading-relaxed text-soft" dangerouslySetInnerHTML={{ __html: data || '<p>Documento vuoto.</p>' }} />;
}

function MermaidView({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    setSvg(null); setErr('');
    renderMermaid(text).then((s) => alive && setSvg(s)).catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [text]);
  if (err) return <div className="text-[13px] text-block">Il diagramma non si disegna: {err}</div>;
  if (!svg) return <Loading />;
  return <div className="cc-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}

interface NbOutput { output_type: string; text?: string | string[]; data?: Record<string, string | string[]>; ename?: string; evalue?: string }
interface NbCell { cell_type: 'markdown' | 'code' | 'raw'; source: string | string[]; outputs?: NbOutput[] }
const joined = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join('') : s ?? '');

function NotebookView({ text, fileBase, dir, onOpen }: { text: string; fileBase: string; dir: string; onOpen?: (p: string) => void }) {
  let nb: { cells?: NbCell[]; metadata?: { kernelspec?: { language?: string } } };
  try { nb = JSON.parse(text); } catch { return <div className="text-[13px] text-block">Notebook non leggibile.</div>; }
  const lang = nb.metadata?.kernelspec?.language ?? 'python';
  return (
    <div className="flex flex-col gap-3">
      {(nb.cells ?? []).slice(0, 300).map((c, i) => (
        <div key={i} className="flex flex-col gap-1.5">
          {c.cell_type === 'markdown' && <div className="text-[14px] leading-relaxed text-soft"><Markdown text={joined(c.source)} fileBase={fileBase} relDir={dir} onOpenFile={onOpen} /></div>}
          {c.cell_type !== 'markdown' && (
            <div className="rounded-[8px] border border-line/70 bg-[oklch(0.15_0_0)] p-2.5"><CodeView text={joined(c.source)} path={`cella.${lang === 'python' ? 'py' : lang}`} /></div>
          )}
          {c.outputs?.map((o, j) => {
            const png = o.data?.['image/png'], jpg = o.data?.['image/jpeg'], svg = o.data?.['image/svg+xml'];
            if (png || jpg) return <img key={j} alt="Risultato della cella" src={`data:image/${png ? 'png' : 'jpeg'};base64,${joined(png ?? jpg).replace(/\s/g, '')}`} className="max-w-full rounded-[6px] bg-white" />;
            if (svg) return <img key={j} alt="Risultato della cella" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(joined(svg))}`} className="max-w-full rounded-[6px] bg-white" />;
            const out = o.output_type === 'error' ? `${o.ename}: ${o.evalue}` : joined(o.text ?? o.data?.['text/plain']);
            return out ? <pre key={j} className={`cc-wrap m-0 max-h-[300px] overflow-y-auto whitespace-pre-wrap px-2.5 font-mono text-[12px] ${o.output_type === 'error' ? 'text-[#FFB0A5]' : 'text-muted'}`}>{out.slice(0, 20_000)}</pre> : null;
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Indirizzi del visore di Office online per il documento. `off`: visore spento (di base: il file uscirebbe verso
 * Microsoft); un errore (file troppo grande) vuol dire lo stesso anteprima di qui.
 */
function useOffice(agentId: string, path: string, on: boolean, chatId?: string): { embed: string | null; page: string | null; off: boolean; err: string } {
  const [state, setState] = useState<{ embed: string | null; page: string | null; off: boolean; err: string }>({ embed: null, page: null, off: false, err: '' });
  useEffect(() => {
    setState({ embed: null, page: null, off: false, err: '' });
    if (!on) return undefined;
    let alive = true;
    api.office(agentId, path, chatId).then((r) => alive && setState({ embed: r.embed ?? null, page: r.page ?? null, off: !!r.off, err: '' }))
      .catch((e) => alive && setState({ embed: null, page: null, off: false, err: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
  }, [agentId, path, on, chatId]);
  return state;
}

/** Excel e Word letti qui; con il visore di Office online acceso, tutti i documenti come li mostra Office. */
function OfficeView({ office, url, path, onAsk }: { office: ReturnType<typeof useOffice>; url: string; path: string; onAsk?: (text: string) => void }) {
  const [loaded, setLoaded] = useState(false);
  if (office.err || office.off) {
    const note = <div className="mb-3 text-[12.5px] text-muted">{office.err ? `${office.err} ` : ''}Qui sotto i contenuti, senza la grafica del file.</div>;
    if (/\.xlsx$/i.test(path)) return <>{note}<SheetView url={url} /></>;
    if (/\.docx$/i.test(path)) return <div className="mx-auto max-w-[860px]">{note}<DocxView url={url} /></div>;
    return <>{office.err && <div className="mb-3 text-[13px] text-block">{office.err}</div>}<Fallback path={path} onAsk={onAsk} /></>;
  }
  if (!office.embed) return <Loading />;
  return (
    <div className="relative h-full min-h-[70vh] w-full">
      {!loaded && <div className="absolute inset-x-0 top-0 p-4"><Loading /></div>}
      <iframe src={office.embed} title={path} onLoad={() => setLoaded(true)} referrerPolicy="no-referrer"
        className="absolute inset-0 h-full w-full rounded-[8px] border border-line bg-white" />
    </div>
  );
}

/**
 * Indirizzo della pagina HTML viva: lo firma il server per la sola cartella della pagina (i file accanto, CSS e immagini,
 * si trovano con indirizzi relativi), e la apre anche in una scheda nuova. Le pagine fuori dal progetto no: errore.
 */
function useHtmlSrc(agentId: string, path: string, on: boolean, chatId?: string): { src: string | null; err: string } {
  const [state, setState] = useState<{ src: string | null; err: string }>({ src: null, err: '' });
  useEffect(() => {
    setState({ src: null, err: '' });
    if (!on) return undefined;
    let alive = true;
    api.viewPage(agentId, path, chatId).then((r) => alive && setState({ src: r.url, err: '' }))
      .catch((e) => alive && setState({ src: null, err: e instanceof Error ? e.message : String(e) }));
    return () => { alive = false; };
  }, [agentId, path, on, chatId]);
  return state;
}

function HtmlView({ src, err, path }: { src: string | null; err: string; path: string }) {
  if (err) return <div className="text-[13px] text-block">{err}</div>;
  if (!src) return <Loading />;
  return (
    <iframe src={src} title={path} sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads" referrerPolicy="no-referrer"
      className="h-full min-h-[60vh] w-full rounded-[8px] border border-line bg-white" />
  );
}

function Fallback({ path, onAsk }: { path: string; onAsk?: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-dashed border-line-hi p-4 text-[13px] leading-relaxed text-muted">
      Il browser non ha un’anteprima per questo formato. Puoi scaricarlo{onAsk ? ', oppure chiedere all’agente di convertirlo' : ''}.
      {onAsk && (
        <button type="button" onClick={() => onAsk(`Converti ${path} in un formato che posso vedere in anteprima (PDF per documenti e presentazioni, XLSX o CSV per i fogli di calcolo, PNG per i disegni) e salvalo accanto all'originale.`)}
          className="cc-press self-start rounded-[8px] border border-line-hi px-3 py-1.5 text-[12.5px] text-text">Chiedi la conversione</button>
      )}
    </div>
  );
}

const btn = 'flex h-8 flex-none items-center justify-center gap-1.5 rounded-[8px] border border-line px-2 text-[12px] text-soft no-underline hover:border-line-hi hover:text-text pointer-coarse:h-11 pointer-coarse:min-w-11';

/**
 * Immagine dell'anteprima che si ingrandisce con due dita (fino a 5x) e si sposta con un dito quando è ingrandita;
 * doppio tocco: 2,5x o di nuovo intera. La pagina intanto non zooma (main.tsx blocca il pizzico di Safari).
 */
function PinchImage({ src, alt }: { src: string; alt: string }) {
  const img = useRef<HTMLImageElement>(null);
  const st = useRef({ scale: 1, x: 0, y: 0, pinch: 0, base: 1, pan: null as null | { x: number; y: number; ox: number; oy: number }, tap: 0 });
  const apply = (animate = false) => {
    const el = img.current;
    if (!el) return;
    const s = st.current;
    el.style.transition = animate ? 'transform .22s cubic-bezier(.25, 1, .5, 1)' : 'none';
    el.style.transform = s.scale === 1 ? '' : `translate(${s.x}px, ${s.y}px) scale(${s.scale})`;
    el.style.touchAction = s.scale > 1 ? 'none' : 'pan-x pan-y';
  };
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  return (
    <img ref={img} src={src} alt={alt} draggable={false}
      onTouchStart={(e) => {
        const s = st.current;
        if (e.touches.length === 2) { s.pinch = dist(e.touches); s.base = s.scale; s.pan = null; }
        else if (e.touches.length === 1) {
          const now = Date.now();
          if (now - s.tap < 300) { s.scale = s.scale > 1 ? 1 : 2.5; s.x = 0; s.y = 0; apply(true); s.tap = 0; return; }
          s.tap = now;
          if (s.scale > 1) s.pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, ox: s.x, oy: s.y };
        }
      }}
      onTouchMove={(e) => {
        const s = st.current;
        if (e.touches.length === 2 && s.pinch) { s.scale = Math.min(5, Math.max(1, s.base * (dist(e.touches) / s.pinch))); if (s.scale === 1) { s.x = 0; s.y = 0; } apply(); }
        else if (e.touches.length === 1 && s.pan) { s.x = s.pan.ox + e.touches[0].clientX - s.pan.x; s.y = s.pan.oy + e.touches[0].clientY - s.pan.y; apply(); }
      }}
      onTouchEnd={(e) => { const s = st.current; if (e.touches.length < 2) s.pinch = 0; if (!e.touches.length) s.pan = null; }}
      className="cc-reveal max-h-[calc(100dvh-140px)] max-w-full rounded-[8px] border border-line object-contain" style={{ touchAction: 'pan-x pan-y' }} />
  );
}

/** Anteprima di un file del repo. `onOpen`: segue i link ad altri file (Markdown, notebook). */
export function FilePreview({ agentId, chatId, path, onAsk, onOpen, actions }: { agentId: string; chatId?: string; path: string; onAsk?: (text: string) => void; onOpen?: (p: string) => void; actions?: ReactNode }) {
  const kind = kindOf(path);
  const url = api.fileUrl(agentId, path, false, chatId);
  const fileBase = fileBaseOf(agentId, chatId);
  const [source, setSource] = useState(false);
  const wantsText = TEXT_KINDS.has(kind) || (source && HAS_SOURCE.has(kind));
  const { data: text, err } = useFetched(wantsText ? url : null, (r) => r.text());
  const html = useHtmlSrc(agentId, path, kind === 'html', chatId);
  const office = useOffice(agentId, path, kind === 'office', chatId);
  const dir = dirOf(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const showSource = source && HAS_SOURCE.has(kind) && !(kind === 'image' && !/\.svg$/i.test(path));
  // Le pagine HTML si aprono vive e i documenti di Office nel loro visore (se acceso), come nell'anteprima; il resto così com'è.
  const tabUrl = kind === 'html' ? html.src : kind === 'office' ? office.page ?? (office.err || office.off ? url : null) : url;

  let body: ReactNode;
  if (showSource) body = text == null ? (err ? null : <Loading />) : <CodeView text={text} path={kind === 'notebook' ? 'nb.json' : path} />;
  else if (kind === 'image') body = <div className="flex min-h-full items-center justify-center overflow-hidden"><PinchImage src={url} alt={path} /></div>;
  else if (kind === 'pdf') body = <iframe src={url} title={path} className="h-full min-h-[60vh] w-full rounded-[8px] border border-line bg-white" />;
  else if (kind === 'video') body = <video src={url} controls playsInline className="max-h-full w-full rounded-[8px] border border-line" />;
  else if (kind === 'audio') body = <audio src={url} controls className="w-full" />;
  else if (kind === 'html') body = <HtmlView src={html.src} err={html.err} path={path} />;
  else if (kind === 'office') body = <OfficeView office={office} url={url} path={path} onAsk={onAsk} />;
  else if (kind === 'model') body = <ModelView url={url} path={path} />;
  else if (kind === 'other') body = <Fallback path={path} onAsk={onAsk} />;
  else if (text == null) body = err ? null : <Loading />;
  else if (kind === 'table') body = <Table rows={parseCsv(text, /\.tsv$/i.test(path) ? '\t' : text.split('\n')[0].includes(';') ? ';' : ',')} />;
  else if (kind === 'markdown') body = <div className="mx-auto max-w-[860px] text-[14.5px] leading-relaxed text-soft"><Markdown text={text} fileBase={fileBase} relDir={dir} onOpenFile={onOpen} /></div>;
  else if (kind === 'mermaid') body = <MermaidView text={text} />;
  else if (kind === 'notebook') body = <div className="mx-auto max-w-[960px]"><NotebookView text={text} fileBase={fileBase} dir={dir} onOpen={onOpen} /></div>;
  else if (kind === 'json') { let pretty = text; try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* lasciato com'è */ } body = <CodeView text={pretty} path={path} />; }
  else body = <CodeView text={text} path={path} />;

  const canToggle = HAS_SOURCE.has(kind) && (kind !== 'image' || /\.svg$/i.test(path));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line/70 py-2.5 pr-2.5 pl-4">
        <div className="flex min-w-0 flex-1 flex-col" title={path}>
          <span className="truncate text-[14px] font-medium text-text">{name}</span>
          {dir && <span className="truncate font-mono text-[11.5px] text-muted">{dir}</span>}
        </div>
        {canToggle && (
          <div role="group" aria-label="Vista" className="flex flex-none rounded-[8px] border border-line p-0.5">
            {[false, true].map((s) => (
              <button key={String(s)} type="button" aria-pressed={source === s} onClick={() => setSource(s)}
                className={`rounded-[6px] px-2 py-1 text-[11.5px] ${source === s ? 'bg-panel-hi text-text' : 'text-muted hover:text-text'}`}>{s ? 'Codice' : 'Anteprima'}</button>
            ))}
          </div>
        )}
        {tabUrl && (
          <a href={tabUrl} target="_blank" rel="noreferrer" aria-label="Apri in una scheda nuova" title="Apri in una scheda nuova" className={btn}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
            <span className="hidden md:inline">Apri</span>
          </a>
        )}
        {canCopy(path) && <CopyButton copy={() => copyFile(url, path)} label="Copia il file" className={`${btn} w-8 px-0`} />}
        <a href={api.fileUrl(agentId, path, true, chatId)} aria-label="Scarica" title="Scarica" className={btn}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
          <span className="hidden md:inline">Scarica</span>
        </a>
        {actions}
      </div>
      <div className="cc-scroll min-h-0 flex-1 overflow-auto p-4">
        {err && <div className="text-[13px] text-block">{err}</div>}
        {body}
      </div>
    </div>
  );
}

export interface PreviewFile {
  agentId: string;
  /** Chat da cui viene: se ha un worktree, i percorsi sono relativi alla sua cartella. */
  chatId?: string;
  path: string;
  /** «Chiedi la conversione» per i formati senza anteprima: scrive la richiesta nel campo della chat. */
  onAsk?: (text: string) => void;
}

/**
 * Anteprima in un riquadro sopra la pagina, come nella app di Claude Code: vale per la chat a pagina intera,
 * il pannello dell'agente e Ciccio. Si chiude con ×, Esc o un clic fuori.
 */
export function FileModal(props: { file: PreviewFile | null; onClose: () => void; onOpen: (path: string) => void }) {
  const open = !!props.file;
  // Telefono: si chiude anche trascinando giù dalla maniglia in alto.
  const drag = useDragControls();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    // Alla chiusura il fuoco torna dove eri (il link del file, il campo di testo).
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); back?.focus({ preventScroll: true }); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Il fuoco va sul riquadro (anche seguendo un link a un altro file), così Tab parte da lì.
  useEffect(() => { if (open) closeRef.current?.focus({ preventScroll: true }); }, [open, props.file?.agentId, props.file?.path]);
  const ask = props.file?.onAsk;
  return (
    <AnimatePresence>
      {props.file && (
        <motion.div key="file-modal" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: quick }} exit={{ opacity: 0, transition: quick }}
          className="cc-viewport z-[65] flex items-stretch justify-center bg-black/65 p-0 backdrop-blur-[2px] sm:p-4 lg:p-6" onClick={props.onClose}>
          <motion.div role="dialog" aria-modal="true" aria-label={`Anteprima di ${props.file.path}`} {...rise}
            drag="y" dragControls={drag} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0.04, bottom: 0.9 }}
            onDragEnd={(_, i) => { if (i.offset.y > 110 || i.velocity.y > 600) props.onClose(); }}
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-[1440px] flex-col overflow-hidden border-line bg-[oklch(0.145_0_0)] pt-(--cc-top) pb-[env(safe-area-inset-bottom)] shadow-[0_12px_32px_rgb(0_0_0/.5)] sm:rounded-[14px] sm:border sm:pt-0 sm:pb-0">
            <div onPointerDown={(e) => drag.start(e)} className="flex flex-none touch-none justify-center pt-2 pb-0.5 sm:hidden"><span className="h-[5px] w-9 rounded-full bg-line-hi" /></div>
            <FilePreview key={`${props.file.agentId}:${props.file.path}`} agentId={props.file.agentId} chatId={props.file.chatId} path={props.file.path} onOpen={props.onOpen}
              onAsk={ask && ((t) => { ask(t); props.onClose(); })}
              actions={(
                <button ref={closeRef} type="button" onClick={props.onClose} aria-label="Chiudi l'anteprima" title="Chiudi (Esc)"
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] text-muted hover:bg-panel-hi hover:text-text pointer-coarse:h-11 pointer-coarse:w-11">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
              )} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
