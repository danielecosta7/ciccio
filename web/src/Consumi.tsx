import { useEffect, useMemo, useState } from 'react';
import { timeAgo } from './api';
import { lastDays, pick, splitKey, stats, type ConsumiReport, type UsageBuckets, type UsageStats } from '../../shared/consumi';

// Impostazioni › Consumi: Ciccio contro Claude Code sul PC, con lo stesso metro (shared/consumi.ts).
// Indicatore principale: token pesati per ora di lavoro dell'agente.

const row = 'grid grid-cols-[minmax(0,1fr)_76px_76px] items-center gap-3 border-t border-line/60 py-2.5 first:border-t-0 text-[13.5px] sm:grid-cols-[minmax(0,1fr)_96px_96px]';
const sub = 'm-0 mt-6 mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted';
const num = 'text-right font-mono text-[12.5px]';
// Colori delle due serie (validati per lo sfondo scuro: luminosità, daltonismo, contrasto).
const C_CICCIO = '#6FA800';
const C_PC = '#5B8DEF';
/** Entro il 10% sono pari. */
const SAME = 0.1;

const it = (n: number, d = 1) => n.toFixed(d).replace('.', ',');
function tok(n: number | null): string {
  if (n == null) return '–';
  if (n >= 1e6) return `${it(n / 1e6, n >= 1e8 ? 0 : 1)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}
const pctOf = (x: number | null, d = 1) => (x == null ? '–' : `${it(x * 100, d)}%`);
const hours = (h: number) => (h >= 10 ? `${Math.round(h)} h` : `${it(h)} h`);
const dayLabel = (d: string) => new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

function Swatch({ color }: { color: string }) {
  return <span aria-hidden="true" className="inline-block h-2.5 w-2.5 flex-none rounded-[2px]" style={{ background: color }} />;
}

/** Giudizio sull'indicatore principale: Ciccio sotto, pari o sopra il PC. */
function Verdict({ c, p }: { c: UsageStats; p: UsageStats }) {
  if (c.wPerHour == null || p.wPerHour == null) {
    return <p className="m-0 text-[13px] text-muted">{c.wPerHour == null ? 'Nessun lavoro degli agenti di Ciccio nel periodo.' : 'Nessun lavoro di Claude Code sul PC nel periodo.'}</p>;
  }
  const r = c.wPerHour / p.wPerHour;
  const diff = Math.round(Math.abs(r - 1) * 100);
  const [tone, text] = r < 1 - SAME ? ['text-done', `Ciccio consuma il ${diff}% in meno del PC per ora di lavoro.`]
    : r > 1 + SAME ? [r > 1.5 ? 'text-block' : 'text-wait', `Ciccio consuma il ${diff}% in più del PC per ora di lavoro.`]
    : ['text-done', `Ciccio consuma come il PC per ora di lavoro (${r >= 1 ? '+' : '−'}${diff}%, entro il 10%).`];
  const word = r < 1 - SAME ? 'Sotto' : r > 1 + SAME ? 'Sopra' : 'Pari';
  return (
    <p className={`m-0 flex items-baseline gap-2 text-[14px] font-medium ${tone}`}>
      <span className="rounded-[6px] border border-current px-1.5 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide">{word}</span>
      <span>{text}</span>
    </p>
  );
}

function Big({ label, color, value, note }: { label: string; color: string; value: number | null; note: string }) {
  return (
    <div className="flex min-w-[150px] flex-1 flex-col gap-1 rounded-[12px] border border-line bg-ink/60 px-4 py-3">
      <span className="flex items-center gap-2 text-[12.5px] text-soft"><Swatch color={color} />{label}</span>
      <span className="font-mono text-[26px] font-semibold leading-none tracking-[-0.02em] text-text">{tok(value)}<span className="ml-1 text-[13px] font-normal text-muted">/ ora</span></span>
      <span className="text-[12px] text-muted">{note}</span>
    </div>
  );
}

function Line({ label, hint, c, p, good }: { label: string; hint?: string; c: string; p: string; good?: [boolean | null, boolean | null] }) {
  const tone = (g: boolean | null | undefined) => (g == null ? 'text-soft' : g ? 'text-done' : 'text-wait');
  return (
    <div className={row}>
      <span className="min-w-0">{label}{hint && <span className="block text-[12px] leading-snug text-muted">{hint}</span>}</span>
      <span className={`${num} ${tone(good?.[0])}`}>{c}</span>
      <span className={`${num} ${tone(good?.[1])}`}>{p}</span>
    </div>
  );
}

/** Token per ora, giorno per giorno: due colonne per giorno (Ciccio e PC), scala comune che parte da zero. */
function Daily({ days, ciccio, pc }: { days: string[]; ciccio: UsageBuckets; pc: UsageBuckets }) {
  const data = [...days].reverse().map((d) => ({ d, c: stats(pick(ciccio, [d])).wPerHour, p: stats(pick(pc, [d])).wPerHour }));
  const max = Math.max(1, ...data.flatMap((x) => [x.c ?? 0, x.p ?? 0]));
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover != null ? data[hover] : null;
  return (
    <div>
      <div className="mb-2 flex min-h-[20px] flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
        <span className="flex items-center gap-1.5"><Swatch color={C_CICCIO} />Ciccio</span>
        <span className="flex items-center gap-1.5"><Swatch color={C_PC} />PC</span>
        <span className="ml-auto font-mono text-[12px] text-soft">
          {shown ? `${dayLabel(shown.d)} · Ciccio ${tok(shown.c)} · PC ${tok(shown.p)}` : `massimo ${tok(max)} / ora`}
        </span>
      </div>
      <div className="flex h-[120px] items-end gap-[3px] border-b border-line" role="img"
        aria-label={`Token pesati per ora di lavoro, giorno per giorno: ${data.map((x) => `${dayLabel(x.d)} Ciccio ${tok(x.c)}, PC ${tok(x.p)}`).join('; ')}`}
        onMouseLeave={() => setHover(null)}>
        {data.map((x, i) => (
          <div key={x.d} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}
            className={`flex h-full min-w-0 flex-1 items-end justify-center gap-[2px] rounded-t-[4px] ${hover === i ? 'bg-panel-hi/70' : ''}`}>
            {[{ v: x.c, color: C_CICCIO }, { v: x.p, color: C_PC }].map((b, j) => (
              <span key={j} className="w-full max-w-[14px] rounded-t-[4px]" style={{ height: b.v ? `${Math.max(2, (b.v / max) * 100)}%` : 0, background: b.color }} />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted">
        <span>{dayLabel(data[0].d)}</span><span>{dayLabel(data[data.length - 1].d)}</span>
      </div>
    </div>
  );
}

function Projects({ buckets, days }: { buckets: UsageBuckets; days: string[] }) {
  const list = useMemo(() => {
    const names = new Set(Object.keys(buckets).map((k) => splitKey(k).project));
    const all = stats(pick(buckets, days)).w;
    return [...names].map((name) => ({ name, s: stats(pick(buckets, days, name)) })).filter((x) => x.s.calls > 0)
      .sort((a, b) => b.s.w - a.s.w).map((x) => ({ ...x, share: all ? x.s.w / all : 0 }));
  }, [buckets, days]);
  if (!list.length) return <p className="m-0 py-2 text-[13px] text-muted">Nessun consumo nel periodo.</p>;
  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-[minmax(0,1fr)_52px_64px_64px] gap-3 pb-1.5 text-[11.5px] text-muted sm:grid-cols-[minmax(0,1fr)_56px_64px_80px_80px]">
        <span>Progetto</span><span className="text-right">Quota</span><span className="text-right">Ore</span><span className="text-right">Per ora</span><span className="hidden text-right sm:block">Per prompt</span>
      </div>
      {list.map(({ name, s, share }) => (
        <div key={name} className="grid grid-cols-[minmax(0,1fr)_52px_64px_64px] items-center gap-3 border-t border-line/60 py-2 text-[13px] sm:grid-cols-[minmax(0,1fr)_56px_64px_80px_80px]">
          <span className="truncate" title={name}>{name}</span>
          <span className={`${num} text-muted`}>{pctOf(share, 0)}</span>
          <span className={`${num} text-muted`}>{hours(s.hours)}</span>
          <span className={num}>{tok(s.wPerHour)}</span>
          <span className={`${num} hidden text-muted sm:block`}>{tok(s.wPerPrompt)}</span>
        </div>
      ))}
    </div>
  );
}

function Toggle<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-none rounded-[8px] border border-line p-0.5">
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" aria-pressed={value === v} onClick={() => onChange(v)}
          className={`rounded-[6px] px-2 py-1 text-[11.5px] ${value === v ? 'bg-panel-hi text-text' : 'text-muted hover:text-text'}`}>{l}</button>
      ))}
    </div>
  );
}

export function ConsumiSection() {
  const [r, setR] = useState<ConsumiReport | null>(null);
  const [error, setError] = useState('');
  const [span, setSpan] = useState<7 | 30>(7);
  const [side, setSide] = useState<'ciccio' | 'pc'>('ciccio');
  // Alla prima lettura dei transcript il server ci mette un po': si riprova finché non ha finito.
  useEffect(() => {
    let timer: number | undefined;
    const load = () => void fetch('/api/consumi').then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Errore ${res.status}`))))
      .then((d: ConsumiReport) => { setR(d); setError(''); if (d.scanning) timer = window.setTimeout(load, 5_000); })
      .catch((e: Error) => setError(e.message));
    load();
    return () => window.clearTimeout(timer);
  }, []);

  const days = useMemo(() => lastDays(span), [span]);
  const c = useMemo(() => (r ? stats(pick(r.ciccio, days)) : null), [r, days]);
  const p = useMemo(() => (r ? stats(pick(r.pc, days)) : null), [r, days]);

  if (error) return <p className="m-0 text-[13px] text-block">{error}</p>;
  if (!r || !c || !p) return <p className="m-0 text-[13px] text-muted">Leggo i consumi…</p>;
  const pcAt = r.pcs.length ? Math.max(...r.pcs.map((x) => x.at)) : null;
  const rewriteOk = (x: number | null) => (x == null ? null : x < 0.02);

  return (
    <div className="flex flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-muted">
          {r.scanning ? 'Prima lettura dei transcript in corso: i numeri crescono finché non finisce.' : `Ultimi ${span} giorni, oggi compreso.`}
        </span>
        <Toggle label="Periodo" value={span} onChange={setSpan} options={[[7, '7 giorni'], [30, '30 giorni']]} />
      </div>

      <div className="flex flex-wrap gap-2.5">
        <Big label="Ciccio" color={C_CICCIO} value={c.wPerHour} note={`${hours(c.hours)} di lavoro · ${c.prompts} prompt`} />
        <Big label="PC (Claude Code)" color={C_PC} value={p.wPerHour} note={r.pcs.length ? `${hours(p.hours)} di lavoro · ${p.prompts} prompt` : 'nessun dato dal PC'} />
      </div>
      <div className="mt-3">
        {r.pcs.length ? <Verdict c={c} p={p} /> : (
          <p className="m-0 text-[13px] text-wait">Il PC non ha ancora mandato i suoi consumi: servono Ciccio Companion 0.8 o successivo, acceso e collegato.</p>
        )}
      </div>

      <h3 className={sub}>Indicatori</h3>
      <div className={`${row} text-[12px] text-muted`}>
        <span />
        <span className="flex items-center justify-end gap-1.5"><Swatch color={C_CICCIO} />Ciccio</span>
        <span className="flex items-center justify-end gap-1.5"><Swatch color={C_PC} />PC</span>
      </div>
      <Line label="Token pesati per ora di lavoro" hint="L'indicatore principale. Ora di lavoro: tempo tra un evento e l'altro della sessione, pause oltre 5 minuti escluse."
        c={tok(c.wPerHour)} p={tok(p.wPerHour)} />
      <Line label="Per prompt" c={tok(c.wPerPrompt)} p={tok(p.wPerPrompt)} />
      <Line label="Per prompt, solo i tuoi" hint="Su Ciccio senza routine, giri di Ciccio, riprese dopo i riavvii e servizi (titoli, riassunti)."
        c={tok(c.wPerPromptOwner)} p={tok(p.wPerPromptOwner)} />
      <Line label="Per prompt automatico" c={tok(c.wPerPromptAuto)} p="–" />
      <Line label="Chiamate per prompt" c={c.callsPerPrompt == null ? '–' : it(c.callsPerPrompt)} p={p.callsPerPrompt == null ? '–' : it(p.callsPerPrompt)} />
      <Line label="Contesto medio per chiamata" hint="Input più cache letta e scritta: quanto rilegge ogni chiamata." c={tok(c.ctxPerCall)} p={tok(p.ctxPerCall)} />
      <Line label="Contesto riscritto in cache" hint="Obiettivo sotto il 2%: sopra, le sessioni riprese a cache scaduta ripagano tutto il contesto."
        c={pctOf(c.cacheRewrite)} p={pctOf(p.cacheRewrite)} good={[rewriteOk(c.cacheRewrite), rewriteOk(p.cacheRewrite)]} />
      <Line label="Prompt" hint="Su Ciccio: tuoi + automatici." c={c.prompts ? `${c.promptsOwner} + ${c.prompts - c.promptsOwner}` : '0'} p={String(p.prompts)} />
      <Line label="Token pesati in tutto" c={tok(c.w)} p={tok(p.w)} />
      <Line label="Per ora, senza il peso del modello" hint="Tutti i modelli contati come Opus: per confrontarli con una misura fatta a mano." c={tok(c.wRawPerHour)} p={tok(p.wRawPerHour)} />

      <h3 className={sub}>Modelli</h3>
      <p className="m-0 mb-1 text-[12px] leading-snug text-muted">Quota dei token pesati. Peso dal listino rispetto a Opus 5.5: Opus 5 1,25 · Sonnet 0,5 · Haiku 0,025 · Fable 2,5.</p>
      {[{ s: c, color: C_CICCIO, name: 'Ciccio' }, { s: p, color: C_PC, name: 'PC' }].map(({ s, color, name }) => (
        <div key={name} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/60 py-2.5 text-[13px] first:border-t-0">
          <span className="flex w-[64px] flex-none items-center gap-1.5"><Swatch color={color} />{name}</span>
          {s.models.length ? s.models.filter((m) => m.share >= 0.005).map((m) => (
            <span key={m.model} className="font-mono text-[12.5px] text-soft">{m.model} <span className="text-muted">{pctOf(m.share, 0)}</span></span>
          )) : <span className="text-[12.5px] text-muted">–</span>}
        </div>
      ))}

      <h3 className={sub}>Andamento per giorno</h3>
      <p className="m-0 mb-2 text-[12px] text-muted">Token pesati per ora di lavoro. Passa sopra una colonna per i numeri.</p>
      <Daily days={days} ciccio={r.ciccio} pc={r.pc} />

      <div className="mt-6 mb-1 flex items-center justify-between gap-3">
        <h3 className={`${sub} m-0`}>Per progetto</h3>
        <Toggle label="Lato" value={side} onChange={setSide} options={[['ciccio', 'Ciccio'], ['pc', 'PC']]} />
      </div>
      <Projects buckets={side === 'ciccio' ? r.ciccio : r.pc} days={days} />

      <p className="m-0 mt-4 text-[12px] leading-relaxed text-muted">
        Token pesati = input + 1,25 × cache scritta (5 min) + 2 × cache scritta (1 h) + 0,1 × cache letta + 5 × output, per il peso del modello.
        Stessi conti sui due lati, dai transcript di Claude Code: sul server quelli di tutti gli agenti, sul PC li legge il companion e manda solo i totali per giorno e progetto.
        {r.updatedAt && ` Ciccio letto ${timeAgo(r.updatedAt)} fa`}{pcAt && `, PC ${timeAgo(pcAt)} fa${r.pcs.length > 1 ? ` (${r.pcs.map((x) => x.name).join(', ')})` : ` (${r.pcs[0].name})`}`}{r.updatedAt || pcAt ? '.' : ''}
      </p>
    </div>
  );
}
