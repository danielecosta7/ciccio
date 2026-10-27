import { useContext, useEffect, useLayoutEffect, useMemo, useRef, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { renderMermaid } from './mermaid';
import { canCopy, copyFile, copyText, downloadFile } from './fileActions';
import { SOURCE_ICON, SourceTitles, hostOf, useSourcePreview } from './Source';
import { knownSize, rememberSize } from './Image';

marked.setOptions({ gfm: true, breaks: true });

const VIDEO = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const AUDIO = /\.(mp3|m4a|wav|ogg|oga|flac|aac|opus)(\?|#|$)/i;
// Estensioni dei file che un agente nomina: un `percorso/file.ext` nel testo diventa una targhetta che apre l'anteprima.
const FILE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|pdf|mp4|webm|mov|m4v|mp3|m4a|wav|ogg|flac|aac|opus|csv|tsv|xlsx|xls|xlsm|docx|doc|pptx|ppt|odp|stl|3mf|obj|step|stp|dxf|gcode|ods|odt|html?|md|markdown|mdx|mmd|mermaid|ipynb|json|jsonc|txt|log|ya?ml|toml|ini|conf|env|css|scss|ts|tsx|mts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|sh|bash|zsh|sql|c|h|cpp|hpp|cs|vue|svelte|astro|xml|zip|srt|vtt)$/i;
// Niente schemi (javascript:alert(1)//x.js finirebbe in un href dopo la pulizia); la lettera di un disco (C:) sì.
const looksLikeFile = (s: string) => !/\s/.test(s) && s.length < 300 && FILE_EXT.test(s) && !/^[a-z][a-z0-9+.-]+:/i.test(s);
// Icone del pulsante copia dei blocchi di codice (come nella app di Claude).
const COPY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const DONE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span>Copiato</span>';
// Icone piccole accanto alle targhette dei file: copia e scarica.
const FILE_COPY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const FILE_DONE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const FILE_DOWN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
/** Indirizzo di un altro sito (non di Ciccio): immagini e media da lì non si caricano da soli. */
const isExternal = (u: string) => { try { return new URL(u, location.href).origin !== location.origin; } catch { return false; } };

/**
 * HTML che arriva dagli agenti o dai file del repo, ripulito: niente script (DOMPurify), e niente di quello che serve a
 * imitare l'interfaccia o a far partire richieste da sole: stili, moduli e pulsanti, SVG e MathML, media incorporati.
 * Video e audio li rimette `enrich` per i file del repo; le caselle delle liste di cose da fare restano.
 */
export const cleanHtml = (html: string) => DOMPurify.sanitize(html, {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'dialog', 'video', 'audio', 'source', 'track', 'picture'],
  FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'ping', 'action', 'formaction'],
});

const isRelative = (u: string) => !!u && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u) && (!u.startsWith('/') || u.startsWith('/home/') || u.startsWith('/tmp/') || u.startsWith('/Users/'));

/** Percorso relativo alla radice del repo, a partire dalla cartella del documento (gestisce ./ e ../). */
export function resolveRel(dir: string, p: string): string {
  // Assoluti e ~/: restano come sono (li risolve il server, con i suoi limiti).
  if (p.startsWith('/') || p.startsWith('~/')) { try { return decodeURI(p.split(/[?#]/)[0]); } catch { return p; } }
  const parts = dir ? dir.split('/') : [];
  let clean = p.split(/[?#]/)[0];
  try { clean = decodeURI(clean); } catch { /* lasciato com'è */ }
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Dopo la pulizia: i percorsi relativi (file del repo dell'agente) passano dall'API dei file,
 * i link a video e audio diventano un player, gli altri file una targhetta che apre l'anteprima,
 * i link esterni si aprono in una scheda nuova.
 */
function enrich(html: string, fileBase?: string, relDir = '', linkFiles = false, fileActions = false, fileUrl?: (path: string) => string | null): string {
  const t = document.createElement('template');
  t.innerHTML = html;
  const file = (p: string) => `${fileBase}${encodeURIComponent(resolveRel(relDir, p))}`;
  // Percorsi scritti come `codice`: come nella app di Claude, si aprono con un clic.
  if (fileBase || linkFiles) {
    t.content.querySelectorAll('code').forEach((code) => {
      if (code.closest('pre, a')) return;
      const p = (code.textContent ?? '').trim();
      if (!looksLikeFile(p)) return;
      const a = document.createElement('a');
      a.textContent = p;
      a.setAttribute('href', p);
      code.replaceWith(a);
    });
  }
  // Ogni blocco ``` ha in alto a destra il pulsante che ne copia il testo grezzo.
  t.content.querySelectorAll('pre').forEach((pre) => {
    const box = document.createElement('div');
    box.className = 'cc-codeblock';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cc-copy';
    btn.title = 'Copia';
    btn.setAttribute('aria-label', 'Copia');
    btn.innerHTML = COPY_ICON;
    pre.replaceWith(box);
    box.append(pre, btn);
  });
  // Immagini: nel riquadro di Image.tsx (segnaposto, dissolvenza, proporzioni ricordate), con un clic l'anteprima grande.
  t.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    const rel = isRelative(src);
    // Senza indirizzo dei file (Ciccio: percorsi «repo/file») lo si chiede a `fileUrl`.
    const url = rel && fileBase ? file(src) : rel ? fileUrl?.(src) ?? src : src;
    // Da un altro sito: non si carica da sola. Un indirizzo scritto da un agente può portare fuori dati (un'immagine
    // https://sito/?dati=… parte dal browser, senza passare dal firewall del server): si mostra con un tocco.
    const remote = /^https?:/i.test(url) && isExternal(url);
    if (remote) { img.removeAttribute('src'); img.dataset.src = url; } else img.setAttribute('src', url);
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    const alt = img.getAttribute('alt') ?? '';
    const box = document.createElement('span');
    box.className = 'cc-img';
    const size = knownSize(url);
    // Già vista: è quasi sempre nella cache del browser, quindi niente segnaposto né dissolvenza (ridisegnando il testo
    // mentre l'agente scrive l'immagine non lampeggia).
    box.dataset.state = remote ? 'remote' : size ? 'ready' : 'loading';
    if (size) { box.style.setProperty('--w', String(size[0])); box.style.setProperty('--r', String(size[0] / size[1])); }
    if (rel && linkFiles) box.dataset.file = fileBase ? resolveRel(relDir, src) : src;
    else if (/^https?:/i.test(url)) box.dataset.href = url;
    if (remote) {
      box.dataset.host = hostOf(url) || 'un altro sito';
      box.tabIndex = 0;
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', `Mostra l'immagine da ${box.dataset.host}${alt ? `: ${alt}` : ''}`);
      box.title = `Immagine da ${box.dataset.host}: tocca per caricarla`;
    } else if (box.dataset.file || box.dataset.href) {
      box.tabIndex = 0;
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', `Anteprima di ${alt || 'immagine'}`);
      box.title = alt ? `${alt} (anteprima)` : 'Anteprima';
    }
    img.replaceWith(box);
    box.append(img);
  });
  t.content.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') ?? '';
    const local = !!fileBase && isRelative(href);
    const url = local ? file(href) : href;
    // Senza indirizzo dei file (Ciccio: percorsi «repo/file») il link resta com'è ma apre comunque l'anteprima.
    const byHandler = !local && linkFiles && isRelative(href);
    // Player solo per i file di Ciccio: un video o un audio di un altro sito si caricherebbe da solo, resta un link.
    const playable = !isExternal(url);
    if (playable && VIDEO.test(href)) {
      const v = document.createElement('video');
      v.src = url; v.controls = true; v.preload = 'metadata'; v.setAttribute('playsinline', '');
      a.replaceWith(v);
      return;
    }
    if (playable && AUDIO.test(href)) {
      const au = document.createElement('audio');
      au.src = url; au.controls = true; au.preload = 'metadata';
      a.replaceWith(au);
      return;
    }
    if (local || byHandler) {
      const rel = resolveRel(relDir, href);
      if (local) a.setAttribute('href', url);
      a.setAttribute('data-file', rel);
      a.classList.add('cc-filelink');
      a.setAttribute('data-ext', (rel.split('/').pop()?.split('.').pop() ?? '').slice(0, 4).toUpperCase());
      // Accanto alla targhetta: copia (immagini e testo) e scarica.
      if (fileActions) {
        const name = rel.split('/').pop() ?? rel;
        const box = document.createElement('span');
        box.className = 'cc-file';
        const acts = document.createElement('span');
        acts.className = 'cc-fileacts';
        const act = (kind: 'copy' | 'download', icon: string, label: string) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'cc-fileact';
          b.dataset.act = kind;
          b.dataset.file = rel;
          b.title = label;
          b.setAttribute('aria-label', `${label} ${name}`);
          b.innerHTML = icon;
          acts.append(b);
        };
        if (canCopy(name)) act('copy', FILE_COPY, 'Copia');
        act('download', FILE_DOWN, 'Scarica');
        a.replaceWith(box);
        box.append(a, acts);
      }
    }
    // Fonte sul web: icona del globo davanti; un indirizzo scritto nudo diventa un'etichetta col dominio.
    const host = local || byHandler ? '' : hostOf(href);
    if (host) {
      const text = (a.textContent ?? '').trim();
      const bare = text === href || /^(https?:\/\/|www\.)/i.test(text);
      a.classList.add('cc-source');
      a.dataset.host = host;
      const ico = document.createElement('img');
      ico.className = 'cc-favicon';
      ico.src = SOURCE_ICON;
      ico.alt = '';
      ico.setAttribute('loading', 'lazy');
      if (bare) {
        a.classList.add('cc-source-bare');
        const label = document.createElement('span');
        label.textContent = host;
        a.replaceChildren(ico, label);
      } else {
        a.prepend(ico);
        // Testo corto: resta su una riga con la sua icona.
        if (text.length <= 32) a.classList.add('cc-nowrap');
      }
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer');
  });
  return t.innerHTML;
}

/**
 * Markdown delle risposte degli agenti, ripulito prima di finire nella pagina.
 * `fileBase`: indirizzo dei file del repo (immagini e link relativi); `relDir`: cartella del documento, per i .md del repo;
 * `onOpenFile`: apre un file nell'anteprima; `fileUrl`: indirizzo di un file nominato, per Copia e Scarica accanto alla targhetta
 * (senza, lo si ricava da `fileBase`; nessuno dei due, niente pulsanti).
 */
export function Markdown({ text, fileBase, relDir, onOpenFile, fileUrl }: { text: string; fileBase?: string; relDir?: string; onOpenFile?: (path: string) => void; fileUrl?: (path: string) => string | null }) {
  const urlOf = fileUrl ?? (fileBase ? (p: string) => `${fileBase}${encodeURIComponent(p)}` : undefined);
  const html = useMemo(() => enrich(cleanHtml(marked.parse(text, { async: false }) as string), fileBase, relDir, !!onOpenFile, !!urlOf, fileUrl), [text, fileBase, relDir, !!onOpenFile, !!urlOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = useRef<HTMLDivElement>(null);

  // Immagini caricate (o no): il riquadro passa da segnaposto a immagine e ne ricorda le misure.
  // Prima del disegno, così un'immagine già nella cache del browser non lampeggia.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const done = (img: HTMLImageElement, ok: boolean) => {
      const pic = img.parentElement;
      // Senza src (immagine di un altro sito, non ancora chiesta) risulta «complete»: resta in attesa del tocco.
      if (!pic?.classList.contains('cc-img') || pic.dataset.state === 'remote') return;
      if (ok && img.naturalWidth) {
        rememberSize(img.getAttribute('src') ?? '', img.naturalWidth, img.naturalHeight);
        pic.style.setProperty('--w', String(img.naturalWidth));
        pic.style.setProperty('--r', String(img.naturalWidth / img.naturalHeight));
      }
      pic.dataset.state = ok ? 'ready' : 'error';
    };
    for (const img of el.querySelectorAll<HTMLImageElement>('.cc-img > img')) if (img.complete) done(img, !!img.naturalWidth);
    const onLoad = (e: Event) => { if (e.target instanceof HTMLImageElement) done(e.target, true); };
    const onError = (e: Event) => { if (e.target instanceof HTMLImageElement) done(e.target, false); };
    // load ed error non risalgono: si prendono in cattura.
    el.addEventListener('load', onLoad, true);
    el.addEventListener('error', onError, true);
    return () => { el.removeEventListener('load', onLoad, true); el.removeEventListener('error', onError, true); };
  }, [html]);
  const openImage = (pic: HTMLElement) => {
    // Immagine di un altro sito: il primo tocco la carica, i successivi la aprono.
    const img = pic.querySelector<HTMLImageElement>('img[data-src]');
    if (pic.dataset.state === 'remote' && img) {
      pic.dataset.state = 'loading';
      img.src = img.dataset.src ?? '';
      img.removeAttribute('data-src');
      pic.setAttribute('aria-label', `Anteprima di ${img.alt || 'immagine'}`);
      pic.title = img.alt ? `${img.alt} (anteprima)` : 'Anteprima';
      return;
    }
    if (pic.dataset.file && onOpenFile) onOpenFile(pic.dataset.file);
    else if (pic.dataset.href) window.open(pic.dataset.href, '_blank', 'noopener,noreferrer');
  };
  // Anteprima delle fonti al passaggio del mouse o col fuoco: titolo dalle ricerche della chat, se c'è.
  const titles = useContext(SourceTitles);
  const preview = useSourcePreview();
  const over = useRef<Element | null>(null);
  const enter = (e: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.cc-source');
    if (!a || a === over.current) return;
    over.current = a;
    const url = a.getAttribute('href') ?? '';
    const own = (a.textContent ?? '').trim();
    preview.show(a, { url, host: a.dataset.host ?? '', title: titles.get(url) ?? (a.classList.contains('cc-source-bare') ? '' : own) });
  };
  const leave = (e: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    if (!over.current || (e.relatedTarget instanceof Node && over.current.contains(e.relatedTarget))) return;
    over.current = null;
    preview.hide();
  };

  // Blocchi ```mermaid: diventano il diagramma; se il codice non è valido resta il codice.
  useEffect(() => {
    const blocks = [...(box.current?.querySelectorAll<HTMLElement>('pre > code.language-mermaid') ?? [])];
    let alive = true;
    for (const code of blocks) {
      const src = code.textContent ?? '';
      void renderMermaid(src).then((svg) => {
        if (!alive || !code.isConnected) return;
        const fig = document.createElement('div');
        fig.className = 'cc-mermaid';
        fig.innerHTML = svg;
        // Il pulsante copia resta sul diagramma e copia il sorgente.
        fig.dataset.src = src;
        code.parentElement?.replaceWith(fig);
      }).catch(() => { /* resta il codice */ });
    }
    return () => { alive = false; };
  }, [html]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button.cc-fileact');
    if (act) {
      const url = urlOf?.(act.dataset.file ?? '');
      if (!url) return;
      if (act.dataset.act === 'download') { downloadFile(url); return; }
      const name = (act.dataset.file ?? '').split('/').pop() ?? '';
      void copyFile(url, name).then(() => {
        act.innerHTML = FILE_DONE;
        act.classList.add('is-done');
        act.title = 'Copiato';
      }, (err: unknown) => {
        act.classList.add('is-error');
        act.title = `Copia non riuscita: ${err instanceof Error ? err.message : String(err)}`;
      }).finally(() => {
        window.clearTimeout(Number(act.dataset.timer));
        act.dataset.timer = String(window.setTimeout(() => { act.innerHTML = FILE_COPY; act.classList.remove('is-done', 'is-error'); act.title = 'Copia'; }, 1500));
      });
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.cc-copy');
    if (btn) {
      const box = btn.parentElement;
      const text = box?.querySelector('pre')?.textContent ?? box?.querySelector<HTMLElement>('.cc-mermaid')?.dataset.src ?? '';
      void copyText(text.replace(/\n$/, '')).then(() => {
        btn.innerHTML = DONE_ICON;
        btn.classList.add('is-done');
        window.clearTimeout(Number(btn.dataset.timer));
        btn.dataset.timer = String(window.setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('is-done'); }, 1500));
      }).catch(() => { btn.title = 'Copia non riuscita'; });
      return;
    }
    // Immagine (non dentro un link, che decide lui): anteprima grande.
    const pic = (e.target as HTMLElement).closest<HTMLElement>('.cc-img[role="button"]');
    if (pic && !pic.closest('a')) { openImage(pic); return; }
    const a = (e.target as HTMLElement).closest('a[data-file]');
    if (a && onOpenFile) { e.preventDefault(); onOpenFile(a.getAttribute('data-file') ?? ''); }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const pic = (e.target as HTMLElement).closest<HTMLElement>('.cc-img[role="button"]');
    if (pic && !pic.closest('a')) { e.preventDefault(); openImage(pic); }
  };
  return (
    <>
      <div ref={box} className="cc-md" onClick={onClick} onKeyDown={onKeyDown} onMouseOver={enter} onMouseOut={leave} onFocus={enter} onBlur={leave} dangerouslySetInnerHTML={{ __html: html }} />
      {preview.node}
    </>
  );
}
