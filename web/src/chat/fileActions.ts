// Copia e Scarica dei file delle chat: le targhette nelle risposte, i file scritti dagli agenti, l'anteprima.

/** Copia negli appunti; senza Clipboard API (http, browser vecchi) passa da una textarea nascosta. */
export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* sotto, il ripiego */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copia non riuscita');
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const TEXT = /\.(txt|text|log|md|markdown|mdx|mmd|csv|tsv|json|jsonc|ya?ml|toml|ini|env|conf|cfg|html?|css|scss|less|xml|svg|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|pl|lua|r|sh|bash|zsh|ps1|sql|c|h|cpp|hpp|cc|cs|vue|svelte|astro|graphql|gql|diff|patch|srt|vtt|properties|gradle|ipynb)$/i;

/** Si copia il contenuto: le immagini come immagine, i file di testo come testo. Gli altri formati gli appunti del browser non li prendono. */
export const canCopy = (name: string) => IMAGE.test(name) || TEXT.test(name);

/** Immagine in PNG, l'unico formato che gli appunti del browser accettano ovunque. */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || 1024;
    canvas.height = img.naturalHeight || 1024;
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('immagine non convertita'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fetched(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status === 404 ? 'file non trovato' : `errore ${r.status}`);
  return r;
}

/** Copia un file (indirizzo dell'API dei file) negli appunti. */
export async function copyFile(url: string, name: string): Promise<void> {
  if (IMAGE.test(name) && !/\.svg$/i.test(name) && typeof ClipboardItem !== 'undefined') {
    // Safari vuole il ClipboardItem subito, dentro il clic: il contenuto arriva dopo, come promessa.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': fetched(url).then((r) => r.blob()).then(asPng) })]);
    return;
  }
  if (!TEXT.test(name)) throw new Error('formato che il browser non sa copiare');
  await copyText(await (await fetched(url)).text());
}

/** Scarica il file con il suo nome, senza lasciare la pagina. */
export function downloadFile(url: string) {
  const a = document.createElement('a');
  a.href = `${url}${url.includes('?') ? '&' : '?'}download=1`;
  a.rel = 'noreferrer';
  document.body.append(a);
  a.click();
  a.remove();
}
