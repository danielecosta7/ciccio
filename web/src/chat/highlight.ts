import type { HLJSApi } from 'highlight.js';

// Colorazione del codice caricata solo quando serve (non pesa sul primo avvio).
let hljs: Promise<HLJSApi> | null = null;
export const loadHighlighter = () => (hljs ??= import('highlight.js/lib/common').then((m) => m.default));

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', ipynb: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini', env: 'bash',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml', astro: 'xml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', php: 'php', pl: 'perl', lua: 'lua', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', sql: 'sql', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
  md: 'markdown', markdown: 'markdown', graphql: 'graphql', gql: 'graphql', diff: 'diff', patch: 'diff', makefile: 'makefile', dockerfile: 'dockerfile',
};

export function langFor(path: string): string | null {
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (name === 'makefile') return 'makefile';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  return LANG[name.includes('.') ? name.split('.').pop()! : ''] ?? null;
}

/** Divide l'HTML colorato in righe: gli span aperti si chiudono a fine riga e si riaprono nella successiva. */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let cur = '';
  for (const m of html.matchAll(/(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g)) {
    if (m[1]) { open.push(m[1]); cur += m[1]; }
    else if (m[2]) { open.pop(); cur += m[2]; }
    else if (m[3]) { lines.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else cur += m[4];
  }
  lines.push(cur + '</span>'.repeat(open.length));
  return lines;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Righe di codice in HTML sicuro (colorate se il linguaggio è noto). */
export async function highlightLines(text: string, lang: string | null): Promise<string[]> {
  if (!lang || text.length > 300_000) return text.split('\n').map(escape);
  const h = await loadHighlighter();
  if (!h.getLanguage(lang)) return text.split('\n').map(escape);
  return splitHighlighted(h.highlight(text, { language: lang, ignoreIllegals: true }).value);
}
