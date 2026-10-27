import { useEffect, useRef, useState } from 'react';
import { timeAgo } from './api';
import { Wizard } from './Wizard';
import { SshHostsEditor } from './Setup';
import { PixelBar, PixelHistory } from './ui';
import type { AppSettings, AuthMode, CompanionView, ServerSample, ServerStats, SkillView, VoiceProviderView } from '../../shared/types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `Errore ${res.status}`), { data });
  return data as T;
}

const EXAMPLES = [
  { label: 'Documenti PDF', url: 'https://github.com/anthropics/skills/tree/main/skills/pdf' },
  { label: 'Fogli Excel', url: 'https://github.com/anthropics/skills/tree/main/skills/xlsx' },
  { label: 'Presentazioni', url: 'https://github.com/anthropics/skills/tree/main/skills/pptx' },
];

/** Skill di Claude Code: quelle installate e il wizard per aggiungerne (da GitHub o da un file). */
export function SkillsSection() {
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [wizard, setWizard] = useState(false);
  const [from, setFrom] = useState<'github' | 'file'>('github');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [installed, setInstalled] = useState<string[]>([]);
  // Skill già installata: si può aggiornare con la versione appena scelta (stesso repo o stesso file).
  const [exists, setExists] = useState<{ id: string; file?: File } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => void json<SkillView[]>('/api/skills').then(setSkills).catch(() => setSkills([]));
  useEffect(load, []);

  const install = async (file?: File, replace = false) => {
    setBusy(true); setError(''); setInstalled([]); setExists(null);
    try {
      const r = file
        ? await json<{ installed: string[]; skills: SkillView[] }>(`/api/skills/upload${replace ? '?replace=1' : ''}`, { method: 'POST', body: (() => { const f = new FormData(); f.append('file', file, file.name); return f; })() })
        : await json<{ installed: string[]; skills: SkillView[] }>('/api/skills/github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, replace }) });
      setInstalled(r.installed);
      setSkills(r.skills);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      const id = (e as { data?: { exists?: string } }).data?.exists;
      if (id) setExists({ id, file });
      load();
    } finally { setBusy(false); }
  };
  const failure = error && (
    <div className="flex flex-wrap items-center gap-2">
      <p className="cc-wrap m-0 text-[12.5px] text-block">{error}</p>
      {exists && <button type="button" onClick={() => void install(exists.file, true)} disabled={busy}
        className="cc-press rounded-[8px] border border-acid/60 px-3 py-1 text-[12.5px] font-medium text-acid hover:bg-acid/[.06] disabled:opacity-40">Aggiorna «{exists.id}»</button>}
    </div>
  );

  const remove = async (id: string) => {
    if (!confirm(`Togliere la skill "${id}"? Gli agenti non la useranno più dal prossimo messaggio.`)) return;
    try { setSkills((await json<{ skills: SkillView[] }>(`/api/skills/${encodeURIComponent(id)}/remove`, { method: 'POST' })).skills); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const choice = (on: boolean) => `cc-press flex-1 rounded-[10px] border px-3 py-2.5 text-left ${on ? 'border-acid/70 bg-acid/[.06]' : 'border-line hover:border-line-hi'}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col">
        {skills?.map((s) => (
          <div key={s.id} className="flex items-start justify-between gap-3 border-t border-line/60 py-2.5 first:border-t-0">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[14px] font-medium">{s.name}</span>
              {s.description && <span className="cc-wrap line-clamp-2 text-[12.5px] leading-snug text-muted">{s.description}</span>}
              {!s.synced && <span className="cc-wrap font-mono text-[11px] text-muted">{s.source ? `${s.source} · ` : ''}{timeAgo(s.installedAt)} fa</span>}
            </span>
            {/* Le sincronizza Claude Code dall'account claude.ai. */}
            {s.synced
              ? <a href="https://claude.ai/settings/capabilities" target="_blank" rel="noreferrer" className="flex-none text-[12px] text-muted hover:text-text">dal tuo account claude.ai ↗</a>
              : <button type="button" onClick={() => void remove(s.id)} className="cc-press min-h-9 flex-none rounded-[8px] border border-line px-3 text-[13px] text-muted hover:border-block/50 hover:text-block">Togli</button>}
          </div>
        ))}
        {skills?.length === 0 && !wizard && <div className="text-[13px] text-muted">Nessuna skill installata.</div>}
      </div>
      {wizard ? (
        <Wizard onDone={() => { setWizard(false); setInstalled([]); setUrl(''); }} doneLabel="Chiudi" steps={[
          {
            title: 'Cosa sono',
            body: (
              <>
                <p className="m-0">Una skill è un pacchetto di istruzioni (e a volte script) che insegna a Claude a fare una cosa precisa: lavorare con i PDF, preparare un foglio Excel, seguire il tuo stile di scrittura.</p>
                <p className="m-0">Le installi una volta e valgono per tutti gli agenti{' '}e per Ciccio: le usano da soli quando servono, dal prossimo messaggio. Installa solo skill di cui ti fidi: possono contenere comandi.</p>
              </>
            ),
          },
          {
            title: 'Da dove',
            body: (
              <div className="flex gap-2">
                <button type="button" onClick={() => setFrom('github')} className={choice(from === 'github')}><span className="block text-[14px] font-medium">Da GitHub</span><span className="text-[12px] text-muted">un repo o una sua cartella</span></button>
                <button type="button" onClick={() => setFrom('file')} className={choice(from === 'file')}><span className="block text-[14px] font-medium">Da un file</span><span className="text-[12px] text-muted">.zip o SKILL.md</span></button>
              </div>
            ),
          },
          {
            title: 'Installa',
            canNext: installed.length > 0,
            body: from === 'github' ? (
              <>
                <p className="m-0">Incolla l'indirizzo del repo, o della cartella che contiene SKILL.md. Funzionano anche i tuoi repo privati.</p>
                <div className="flex gap-2">
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/…" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                    className="min-w-0 flex-1 rounded-[10px] border border-line bg-ink px-3 py-2 font-mono text-[12.5px] outline-none focus:border-acid" />
                  <button type="button" onClick={() => void install()} disabled={busy || !url.trim()}
                    className="cc-press flex-none rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink disabled:opacity-40">{busy ? 'Installo…' : 'Installa'}</button>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[12px]">
                  <span className="text-muted">Esempi ufficiali:</span>
                  {EXAMPLES.map((x) => <button key={x.url} type="button" onClick={() => setUrl(x.url)} className="rounded-full border border-line px-2.5 py-0.5 text-soft hover:border-acid/50">{x.label}</button>)}
                </div>
                {installed.length > 0 && <p className="m-0 font-medium text-done">Installata: {installed.join(', ')}.</p>}
                {failure}
              </>
            ) : (
              <>
                <p className="m-0">Scegli un .zip con una o più skill, oppure un singolo SKILL.md.</p>
                <input ref={fileRef} type="file" accept=".zip,.md" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void install(f); e.target.value = ''; }} />
                <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}
                  className="cc-press self-start rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink disabled:opacity-40">{busy ? 'Installo…' : 'Scegli il file'}</button>
                {installed.length > 0 && <p className="m-0 font-medium text-done">Installata: {installed.join(', ')}.</p>}
                {failure}
              </>
            ),
          },
          {
            title: 'Fatto',
            body: (
              <>
                <p className="m-0 font-medium text-text">{installed.length === 1 ? `La skill «${installed[0]}» è pronta.` : `Pronte: ${installed.join(', ')}.`}</p>
                <p className="m-0">Gli agenti la usano da soli quando serve, a partire dal prossimo messaggio. Per provarla, chiedi a un agente qualcosa che la richieda.</p>
              </>
            ),
          },
        ]} />
      ) : (
        <button type="button" onClick={() => setWizard(true)} className="cc-press self-start rounded-[10px] border border-dashed border-acid/60 px-3.5 py-2 text-[13px] font-medium text-acid hover:bg-acid/[.06]">+ Aggiungi una skill</button>
      )}
    </div>
  );
}

/** Connettori di claude.ai (Gmail, Calendar, Notion…): stato e wizard per collegarne di nuovi. */
export function ConnectorsSection() {
  const [list, setList] = useState<{ name: string; status: string }[] | null>(null);
  const [wizard, setWizard] = useState(false);
  const load = () => void json<{ name: string; status: string }[]>('/api/connectors').then(setList).catch(() => setList([]));
  useEffect(load, []);
  const label = (s: string) => (s === 'connected' ? 'collegato' : s === 'needs-auth' ? 'da autorizzare' : s === 'pending' ? 'in collegamento' : s === 'failed' ? 'errore' : s);
  const color = (s: string) => (s === 'connected' ? 'text-done' : s === 'needs-auth' ? 'text-wait' : s === 'failed' ? 'text-block' : 'text-muted');
  const toAuth = list?.filter((c) => c.status === 'needs-auth') ?? [];
  return (
    <div className="flex flex-col gap-3">
      {list && list.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1.5">
          {list.map((c) => (
            <span key={c.name} className="flex items-center justify-between gap-2 rounded-[8px] border border-line/70 px-2.5 py-1.5 text-[12.5px]">
              <span className="truncate">{c.name}</span><span className={`flex-none ${color(c.status)}`}>{label(c.status)}</span>
            </span>
          ))}
        </div>
      )}
      {list?.length === 0 && <div className="text-[13px] text-muted">L'elenco compare dopo il primo messaggio a un agente con i connettori accesi.</div>}
      {wizard ? (
        <Wizard onDone={() => { setWizard(false); load(); }} doneLabel="Chiudi" steps={[
          {
            title: 'Come funzionano',
            body: (
              <>
                <p className="m-0">I connettori sono quelli del tuo account claude.ai: Gmail, Google Calendar, Notion, Microsoft 365, i tuoi MCP. Ciccio e gli agenti li usano con il tuo account, come fai tu su claude.ai.</p>
                <p className="m-0">Le letture passano da sole; le azioni che inviano, creano o modificano qualcosa ti chiedono conferma, secondo il livello della chat.</p>
              </>
            ),
          },
          {
            title: 'Collega su claude.ai',
            body: (
              <>
                <p className="m-0">{toAuth.length ? `Da autorizzare: ${toAuth.map((c) => c.name).join(', ')}.` : 'Per aggiungere un connettore o autorizzarne uno:'} Apri le impostazioni dei connettori su claude.ai, premi «Connetti» sul servizio e completa l'accesso.</p>
                <a href="https://claude.ai/settings/connectors" target="_blank" rel="noreferrer" className="cc-press self-start rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink">Apri i connettori su claude.ai</a>
              </>
            ),
            next: "Fatto, l'ho collegato",
          },
          {
            title: 'Verifica',
            body: (
              <>
                <p className="m-0">Il nuovo stato si vede dal prossimo messaggio a un agente o a Ciccio: è lì che la sessione si collega ai connettori. Chiedi per esempio a Ciccio «quali connettori hai?», poi torna qui.</p>
                <button type="button" onClick={load} className="cc-press self-start rounded-[10px] border border-line-hi px-3.5 py-2 text-[13px]">Aggiorna l'elenco</button>
              </>
            ),
          },
        ]} />
      ) : (
        <button type="button" onClick={() => setWizard(true)} className="cc-press self-start rounded-[10px] border border-dashed border-acid/60 px-3.5 py-2 text-[13px] font-medium text-acid hover:bg-acid/[.06]">
          {toAuth.length ? `Autorizza ${toAuth.length} connettori` : '+ Collega un connettore'}
        </button>
      )}
    </div>
  );
}

export interface ServerInfo {
  commit: string | null; node: string; uptime: number; voice: boolean; diskFreeGb: number | null; diskTotalGb: number | null; projects: number;
  /** Dove sta il codice sorgente di questo Ciccio (CICCIO_SOURCE_URL); manca nei server di prima. */
  source?: string;
  auth: { mode: AuthMode; seenAt: number | null }; timeZone: string;
}

const AUTH_LABEL: Record<AuthMode, string> = {
  subscription: 'login di claude.ai (abbonamento)',
  none: 'nessun login di claude.ai',
};

const GB = 1024 ** 3;
const gb = (b: number) => (b >= 10 * GB ? Math.round(b / GB) : Math.round((b / GB) * 10) / 10).toLocaleString('it-IT');
const rate = (b: number) => (b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1).replace('.', ',')} MB/s` : `${Math.round(b / 1024)} KB/s`);
const up = (s: number) => (s > 86400 ? `${Math.round(s / 86400)} g` : s > 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);
const row = 'flex items-center justify-between gap-3 border-t border-line/60 py-2.5 first:border-t-0 text-[13.5px]';
const sub = 'm-0 mt-5 mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted';

/** Riga con barra a quadratini: nome, barra, valore. */
function Meter({ label, pct, value, hint }: { label: string; pct: number | null; value: string; hint?: string }) {
  return (
    <div className={row} title={hint}>
      <span className="min-w-0">{label}{hint && <span className="block text-[12px] text-muted">{hint}</span>}</span>
      <span className="flex flex-none items-center gap-2.5">
        <PixelBar pct={pct} />
        <span className="w-[122px] whitespace-nowrap text-right font-mono text-[12.5px] text-muted">{value}</span>
      </span>
    </div>
  );
}

type Span = 'hour' | 'day';

interface EgressList { base: number; extra: { domain: string; subdomains: boolean; who: string; at: string }[] }

/** Domini che gli agenti hanno chiesto (consenti_dominio) e l'utente ha aperto nel proxy in uscita: si tolgono da qui. */
function EgressDomains() {
  const [list, setList] = useState<EgressList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { void json<EgressList>('/api/egress').then(setList).catch(() => undefined); }, []);
  const remove = (domain: string) => {
    if (!confirm(`Chiudere ${domain}? Gli agenti non lo raggiungeranno più finché non lo richiedono.`)) return;
    setBusy(domain); setError('');
    void json<EgressList>('/api/egress/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dominio: domain }) })
      .then(setList).catch((e: Error) => setError(e.message)).finally(() => setBusy(null));
  };
  if (!list) return null;
  return (
    <>
      <h3 className={sub}>Domini aperti agli agenti</h3>
      <p className="m-0 mb-1 text-[12.5px] leading-relaxed text-muted">
        Gli agenti escono su internet solo da un proxy con un elenco di domini: {list.base} fissi (Anthropic, GitHub, npm, PyPI…) più quelli che
        hanno chiesto e tu hai aperto. Quando un sito gli serve, lo chiedono e ti arriva la richiesta in chat.
      </p>
      {list.extra.length === 0 && <div className={`${row} text-muted`}>Nessun dominio aggiunto finora.</div>}
      {list.extra.map((x) => (
        <div key={x.domain} className={row}>
          <span className="min-w-0">
            <span className="font-mono text-[12.5px]">{x.domain}</span>{x.subdomains && <span className="text-muted"> e sottodomini</span>}
            <span className="block truncate text-[12px] text-muted">{x.who}{x.at ? ` · ${new Date(x.at).toLocaleDateString('it-IT')}` : ''}</span>
          </span>
          <button type="button" disabled={busy === x.domain} onClick={() => remove(x.domain)}
            className="cc-press min-h-9 flex-none rounded-[8px] border border-line px-3 text-[13px] text-soft disabled:opacity-40">{busy === x.domain ? 'Chiudo…' : 'Chiudi'}</button>
        </div>
      ))}
      {error && <div className="pt-2 text-[12.5px] text-block">{error}</div>}
    </>
  );
}

/** Stato e prestazioni del server: versione, servizi, CPU, memoria, disco, rete e chi pesa di più. */
export function ServerSection() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [span, setSpan] = useState<Span>('hour');
  useEffect(() => { void json<ServerInfo>('/api/server').then(setInfo).catch(() => undefined); }, []);
  // Si aggiorna ogni 10 secondi mentre la pagina è in vista (il server campiona ogni 30).
  useEffect(() => {
    const load = () => { if (document.visibilityState === 'visible') void json<ServerStats>('/api/server/stats').then(setStats).catch(() => undefined); };
    load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, []);

  const now: ServerSample | undefined = stats?.hour[stats.hour.length - 1];
  const p = (v: number, max: number | null | undefined) => (max ? Math.round((v / max) * 100) : null);
  const series = stats ? stats[span] : [];
  const history = (label: string, pick: (x: ServerSample) => number) => (
    <div className="flex flex-col gap-1.5 py-2">
      <span className="text-[12.5px] text-soft">{label}</span>
      {series.length ? <PixelHistory values={series.map(pick)} label={`${label}, ${span === 'hour' ? 'ultima ora' : 'ultime 24 ore'}`} /> : <span className="text-[12px] text-muted">Raccolgo i dati: torna tra qualche minuto.</span>}
    </div>
  );

  return (
    <div className="flex flex-col">
      {info && (
        <>
          <div className={row}><span>Versione</span><span className="font-mono text-[12.5px] text-muted">{info.commit ?? '–'} · Node {info.node.replace(/^v/, '')}</span></div>
          {info.source && (
            <div className={row}>
              <span>Codice sorgente <span className="text-[12px] text-muted">AGPL-3.0</span></span>
              <a href={info.source} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate font-mono text-[12.5px] text-muted underline-offset-2 hover:text-soft hover:underline"
                title={info.commit ? `Questo Ciccio è al commit ${info.commit}` : undefined}>{info.source.replace(/^https?:\/\//, '')}</a>
            </div>
          )}
          <div className={row}><span>Acceso da</span><span className="font-mono text-[12.5px] text-muted">Ciccio {up(info.uptime)}{stats ? ` · VPS ${up(stats.uptime)}` : ''}</span></div>
          <div className={row}><span>Accesso a Claude</span><span className={`text-[12.5px] ${info.auth.mode === 'none' ? 'text-block' : 'text-muted'}`}>{AUTH_LABEL[info.auth.mode]}</span></div>
          <div className={row}><span>Fuso orario</span><span className="font-mono text-[12.5px] text-muted">{info.timeZone}</span></div>
          <div className={row}>
            <span>Progetti sul server <span className="font-mono text-muted">{info.projects}</span></span>
            <button type="button" disabled={syncing} onClick={() => { setSyncing(true); void fetch('/api/agents/sync', { method: 'POST' }).then(() => json<ServerInfo>('/api/server')).then(setInfo).finally(() => setSyncing(false)); }}
              className="cc-press min-h-9 rounded-[8px] border border-line px-3 text-[13px] text-soft disabled:opacity-40">{syncing ? 'Rileggo…' : 'Rileggi la cartella'}</button>
          </div>
        </>
      )}

      {stats && now && (
        <>
          <h3 className={sub}>Adesso</h3>
          <Meter label="CPU" pct={Math.round(now.cpu * 100)} value={`${Math.round(now.cpu * 100)}% · ${stats.cores} core`} hint={`Carico medio: ${now.load.toFixed(2).replace('.', ',')}`} />
          <Meter label="Memoria" pct={p(now.memUsed, stats.memTotal)} value={`${gb(now.memUsed)} di ${gb(stats.memTotal)} GB`} />
          {stats.swapTotal > 0 && <Meter label="Swap" pct={p(now.swapUsed, stats.swapTotal)} value={`${gb(now.swapUsed)} di ${gb(stats.swapTotal)} GB`} />}
          <Meter label="Disco" pct={p(now.diskUsed, stats.diskTotal)} value={`${gb(now.diskUsed)} di ${gb(stats.diskTotal)} GB`} />
          <Meter label="Ciccio e agenti · memoria" pct={p(now.groupMem, stats.groupMemMax)} value={stats.groupMemMax ? `${gb(now.groupMem)} di ${gb(stats.groupMemMax)} GB` : `${gb(now.groupMem)} GB`}
            hint="Oltre il limite il sistema ferma gli agenti." />
          <Meter label="Ciccio e agenti · CPU" pct={p(now.groupCpu, stats.groupCpuMax)} value={`${now.groupCpu.toFixed(1).replace('.', ',')} di ${stats.groupCpuMax ?? stats.cores} core`} />
          <div className={row}><span>Rete</span><span className="font-mono text-[12.5px] text-muted">↓ {rate(now.rx)} · ↑ {rate(now.tx)}</span></div>

          <div className="mt-5 mb-1 flex items-center justify-between gap-3">
            <h3 className={`${sub} m-0`}>Andamento</h3>
            <div role="group" aria-label="Periodo" className="flex flex-none rounded-[8px] border border-line p-0.5">
              {(['hour', 'day'] as Span[]).map((x) => (
                <button key={x} type="button" aria-pressed={span === x} onClick={() => setSpan(x)}
                  className={`rounded-[6px] px-2 py-1 text-[11.5px] ${span === x ? 'bg-panel-hi text-text' : 'text-muted hover:text-text'}`}>{x === 'hour' ? 'Ultima ora' : '24 ore'}</button>
              ))}
            </div>
          </div>
          {history('CPU', (x) => x.cpu * 100)}
          {history('Memoria', (x) => (x.memUsed / stats.memTotal) * 100)}
          {stats.groupMemMax && history('Ciccio e agenti · memoria', (x) => (x.groupMem / stats.groupMemMax!) * 100)}

          <h3 className={sub}>Servizi</h3>
          {stats.services.map((x) => (
            <div key={x.label} className={row}>
              <span>{x.label}</span>
              <span className={`flex items-center gap-2 ${x.active ? 'text-done' : 'text-block'}`}>
                <span className={`h-2 w-2 ${x.active ? 'bg-done' : 'bg-block'}`} aria-hidden="true" />{x.active ? 'attivo' : 'spento'}
              </span>
            </div>
          ))}

          <EgressDomains />

          {stats.top.length > 0 && <h3 className={sub}>Chi pesa di più</h3>}
          {stats.top.slice(0, 6).map((x) => (
            <div key={x.pid} className={row}>
              <span className="min-w-0 truncate font-mono text-[12.5px]">{x.name}{x.project && <span className="text-muted"> · {x.project}</span>}</span>
              <span className="flex-none font-mono text-[12.5px] text-muted">{Math.round(x.cpu * 100)}% CPU · {gb(x.mem)} GB</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── Servizi vocali esterni ───────────────────────────────────────────────

interface ProviderGuide {
  id: VoiceProviderView['id'];
  what: string;
  privacy: string;
  cost: string;
  keyUrl: string;
  keySteps: string[];
  uses: ('stt' | 'tts')[];
}

const GUIDES: ProviderGuide[] = [
  {
    id: 'elevenlabs',
    what: 'Le voci italiane più realistiche (modello Flash, veloce) e la trascrizione Scribe, molto precisa.',
    privacy: "L'audio di quello che dici e il testo delle risposte vanno a ElevenLabs.",
    cost: 'Piano gratuito con 10.000 caratteri di voce al mese; poi abbonamento.',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    keySteps: ['Accedi a ElevenLabs.', 'In Developers › API Keys premi «Create API Key», chiamala «Ciccio».', 'Permessi: Text to Speech, Speech to Text e Voices (lettura). Crea e copia la chiave.'],
    uses: ['tts', 'stt'],
  },
  {
    id: 'openai',
    what: 'Trascrizione gpt-4o-mini-transcribe (precisa e veloce) e voce gpt-4o-mini-tts, con voci naturali.',
    privacy: "L'audio e il testo vanno a OpenAI; via API non li usano per addestrare i modelli.",
    cost: 'A consumo: pochi centesimi per decine di minuti. Serve credito sul conto API.',
    keyUrl: 'https://platform.openai.com/api-keys',
    keySteps: ['Accedi a platform.openai.com (è diverso da ChatGPT).', 'Premi «Create new secret key», chiamala «Ciccio» e copiala: si vede una volta sola.', 'In Billing aggiungi un po\' di credito, altrimenti le richieste vengono rifiutate.'],
    uses: ['stt', 'tts'],
  },
  {
    id: 'deepgram',
    what: 'Trascrizione Nova-3 rapidissima e voci italiane Aura-2 per Ciccio: adatte a una conversazione fluida.',
    privacy: "L'audio di quello che dici, e il testo che Ciccio ti legge se scegli la sua voce, vanno a Deepgram.",
    cost: '200 $ di credito gratuito all\'inizio, poi a consumo.',
    keyUrl: 'https://console.deepgram.com/',
    keySteps: ['Accedi alla console Deepgram.', 'In API Keys premi «Create a New API Key», chiamala «Ciccio», ruolo Member.', 'Copia la chiave.'],
    uses: ['stt', 'tts'],
  },
];

/** Servizi vocali esterni: stato e wizard di collegamento guidato per ciascuno. */
export function VoiceProvidersSection(props: { settings: AppSettings; onUse: (patch: Partial<AppSettings>) => void; list: VoiceProviderView[] | null; onList: (l: VoiceProviderView[]) => void }) {
  const list = props.list;
  const setList = props.onList;
  const [open, setOpen] = useState<VoiceProviderView['id'] | null>(null);
  const load = () => void json<VoiceProviderView[]>('/api/voice/providers').then(setList).catch(() => setList([]));
  const disconnect = async (id: VoiceProviderView['id']) => {
    if (!confirm('Scollegare il servizio? La chiave viene cancellata dal server; se lo stavi usando torno ai servizi sul server.')) return;
    setList((await json<{ providers: VoiceProviderView[] }>(`/api/voice/providers/${id}/remove`, { method: 'POST' })).providers);
  };
  return (
    <div className="flex flex-col gap-2">
      {list?.map((p) => {
        const g = GUIDES.find((x) => x.id === p.id)!;
        return (
          <div key={p.id} className="flex flex-col gap-2 rounded-[10px] border border-line px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex min-w-0 flex-col">
                <span className="text-[14px] font-medium">{p.name} <span className="font-normal text-muted">· {[p.stt && 'trascrizione', p.tts && 'voce'].filter(Boolean).join(' e ')}</span></span>
                <span className={`text-[12px] ${p.connected ? 'text-done' : 'text-muted'}`}>{p.connected ? `Collegato · chiave ····${p.last4}` : 'Non collegato'}</span>
              </span>
              {p.connected
                ? <button type="button" onClick={() => void disconnect(p.id)} className="cc-press min-h-9 rounded-[8px] border border-line px-3 text-[13px] text-muted hover:border-block/50 hover:text-block">Scollega</button>
                : open !== p.id && <button type="button" onClick={() => setOpen(p.id)} className="cc-press min-h-9 rounded-[8px] bg-acid px-3 text-[13px] font-semibold text-ink">Collega</button>}
            </div>
            {open === p.id && <ProviderWizard guide={g} name={p.name} settings={props.settings} onUse={props.onUse}
              onConnected={(l) => setList(l)} onClose={() => { setOpen(null); load(); }} />}
          </div>
        );
      })}
    </div>
  );
}

function ProviderWizard(props: { guide: ProviderGuide; name: string; settings: AppSettings; onUse: (patch: Partial<AppSettings>) => void; onConnected: (l: VoiceProviderView[]) => void; onClose: () => void }) {
  const g = props.guide;
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState(false);
  const [voices, setVoices] = useState<{ id: string; name: string; hint: string }[]>([]);

  const verify = async () => {
    setBusy(true); setError('');
    try {
      const r = await json<{ providers: VoiceProviderView[] }>(`/api/voice/providers/${g.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
      setOk(true); setKey('');
      props.onConnected(r.providers);
      if (g.uses.includes('tts')) void json<{ id: string; name: string; hint: string }[]>(`/api/voice/providers/${g.id}/voices`).then(setVoices).catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const s = props.settings;
  return (
    <Wizard onDone={props.onClose} doneLabel="Fatto" steps={[
      {
        title: 'Cosa offre',
        body: (
          <>
            <p className="m-0">{g.what}</p>
            <p className="m-0 text-wait">{g.privacy}</p>
            <p className="m-0 text-[12.5px] text-muted">{g.cost}</p>
          </>
        ),
      },
      {
        title: 'Crea la chiave',
        body: (
          <>
            <ol className="m-0 flex flex-col gap-1 pl-5">{g.keySteps.map((t) => <li key={t}>{t}</li>)}</ol>
            <a href={g.keyUrl} target="_blank" rel="noreferrer" className="cc-press self-start rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink">Apri {props.name}</a>
          </>
        ),
        next: 'Ho la chiave',
      },
      {
        title: 'Incolla e verifica',
        canNext: ok,
        body: (
          <>
            <p className="m-0">Incolla la chiave: la provo con una richiesta gratuita e la salvo solo sul server. Qui vedrai solo le ultime 4 cifre.</p>
            <div className="flex gap-2">
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Chiave API" autoComplete="off" spellCheck={false}
                className="min-w-0 flex-1 rounded-[10px] border border-line bg-ink px-3 py-2 font-mono text-[12.5px] outline-none focus:border-acid" />
              <button type="button" onClick={() => void verify()} disabled={busy || key.trim().length < 12}
                className="cc-press flex-none rounded-[10px] bg-acid px-4 py-2 text-[13.5px] font-semibold text-ink disabled:opacity-40">{busy ? 'Verifico…' : 'Verifica'}</button>
            </div>
            {ok && <p className="m-0 font-medium text-done">Chiave valida: {props.name} è collegato.</p>}
            {error && <p className="cc-wrap m-0 text-[12.5px] text-block">{error}</p>}
          </>
        ),
      },
      {
        title: 'Usalo',
        body: (
          <>
            <p className="m-0">Scegli per cosa usarlo. Puoi cambiare quando vuoi qui sopra.</p>
            <div className="flex flex-wrap gap-2">
              {g.uses.includes('stt') && (
                <button type="button" onClick={() => props.onUse({ sttEngine: g.id })}
                  className={`cc-press rounded-[10px] border px-3.5 py-2 text-[13px] ${s.sttEngine === g.id ? 'border-acid/70 bg-acid/[.06] text-acid' : 'border-line-hi'}`}>{s.sttEngine === g.id ? '✓ Trascrizione' : 'Usa per la trascrizione'}</button>
              )}
              {g.uses.includes('tts') && (
                <button type="button" onClick={() => props.onUse({ ttsEngine: g.id as AppSettings['ttsEngine'], ttsVoice: voices[0]?.id ?? (g.id === 'openai' ? 'coral' : '') })}
                  className={`cc-press rounded-[10px] border px-3.5 py-2 text-[13px] ${s.ttsEngine === g.id ? 'border-acid/70 bg-acid/[.06] text-acid' : 'border-line-hi'}`}>{s.ttsEngine === g.id ? '✓ Voce di Ciccio' : 'Usa per la voce'}</button>
              )}
            </div>
            {s.ttsEngine === g.id && voices.length > 0 && (
              <label className="flex flex-col gap-1">
                <span className="text-[12.5px] text-muted">Voce</span>
                <select value={s.ttsVoice} onChange={(e) => props.onUse({ ttsVoice: e.target.value })}
                  className="min-h-10 rounded-[10px] border border-line bg-ink px-3 text-[14px] text-text outline-none focus:border-acid">
                  {voices.map((v) => <option key={v.id} value={v.id}>{v.name}{v.hint ? ` · ${v.hint}` : ''}</option>)}
                </select>
              </label>
            )}
          </>
        ),
      },
    ]} />
  );
}

/** Scelta della voce per un servizio esterno già collegato (fuori dal wizard). */
type ExtVoice = { id: string; name: string; hint: string; group?: string; disabled?: boolean };

export function ExternalVoicePicker(props: { engine: 'openai' | 'elevenlabs' | 'deepgram'; value: string; onChange: (v: string) => void }) {
  const [voices, setVoices] = useState<ExtVoice[] | null>(null);
  useEffect(() => { setVoices(null); void json<ExtVoice[]>(`/api/voice/providers/${props.engine}/voices`).then(setVoices).catch(() => setVoices([])); }, [props.engine]);
  const option = (v: ExtVoice) => <option key={v.id} value={v.id} disabled={v.disabled}>{v.name}{v.hint ? ` · ${v.hint}` : ''}</option>;
  // Raggruppate (es. ElevenLabs: italiane della libreria, poi quelle del tuo account).
  const groups = [...new Set((voices ?? []).map((v) => v.group ?? ''))];
  return (
    <select aria-label="Voce del servizio esterno" value={props.value} onChange={(e) => props.onChange(e.target.value)}
      className="min-h-10 max-w-[260px] rounded-[10px] border border-line bg-ink px-3 text-[14px] text-text outline-none hover:border-line-hi focus:border-acid">
      {voices == null && <option>Carico le voci…</option>}
      {voices != null && !voices.some((v) => v.id === props.value) && <option value={props.value}>{props.value ? 'Voce scelta' : 'Scegli una voce'}</option>}
      {groups.map((g) => g
        ? <optgroup key={g} label={g}>{voices!.filter((v) => v.group === g).map(option)}</optgroup>
        : voices!.filter((v) => !v.group).map(option))}
    </select>
  );
}

/** Credenziali da 1Password: chiavi SSH e segreti per gli agenti, dal Mac o dal PC Windows con il companion acceso. */
export function CredentialsSection({ companions, device, onDevice }: { companions: CompanionView[]; device: string; onDevice: (id: string) => void }) {
  const online = companions.filter((c) => c.online);
  const ready = (k: 'sshAgent' | 'cli') => online.some((c) => c.onePassword?.[k]);
  const Dot = ({ on }: { on: boolean }) => <span className={`inline-block h-2 w-2 flex-none ${on ? 'bg-done' : 'bg-line-hi'}`} aria-hidden="true" />;
  const chosen = companions.find((c) => c.id === device);
  return (
    <div className="flex flex-col gap-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13.5px] font-semibold">PC per 1Password</span>
        <select value={chosen ? device : ''} onChange={(e) => onDevice(e.target.value)}
          className="min-h-10 max-w-[420px] rounded-[10px] border border-line bg-ink px-3 text-[14px] text-text outline-none hover:border-line-hi focus:border-acid">
          <option value="">Automatico: il PC collegato da più tempo</option>
          {companions.map((c) => <option key={c.id} value={c.id}>{c.name}{c.online ? '' : ' (spento)'}</option>)}
        </select>
        <span className="text-[12.5px] leading-relaxed text-muted">
          {chosen
            ? `Chiavi SSH e segreti arrivano solo da ${chosen.name}: se è spento, gli agenti te lo dicono invece di chiedere a un altro PC.`
            : 'Un Mac in stop col coperchio chiuso si ricollega da solo ogni tanto: scegli qui il PC davanti a cui sei, così le richieste di 1Password arrivano lì.'}
        </span>
      </label>

      <div className="flex flex-col gap-2">
        {online.length === 0 && <div className="text-[13px] text-muted">Nessun PC con il companion acceso: chiavi SSH e segreti arrivano solo da lì.</div>}
        {online.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-[10px] border border-line px-3.5 py-2.5 text-[13.5px]">
            <span className="font-medium">{c.name}</span>
            <span className="flex items-center gap-2 text-soft"><Dot on={!!c.onePassword?.sshAgent} />Agent SSH di 1Password</span>
            <span className="flex items-center gap-2 text-soft"><Dot on={!!c.onePassword?.cli} />CLI op</span>
          </div>
        ))}
      </div>

      {(!ready('sshAgent') || !ready('cli')) && (
        <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-soft">
          <div className="font-semibold text-text">Per attivarle sul Mac o sul PC Windows</div>
          <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5">
            {!ready('sshAgent') && <li>1Password › Impostazioni › Sviluppatore: accendi <b>Usa l'agent SSH</b>. Su Windows, se 1Password lo chiede, spegni prima il servizio «OpenSSH Authentication Agent» di Windows.</li>}
            {!ready('cli') && <li>Installa la CLI: sul Mac nel Terminale <code className="rounded-[4px] bg-ink px-1.5 py-0.5 font-mono text-[12.5px]">brew install 1password-cli</code>, su Windows in PowerShell <code className="rounded-[4px] bg-ink px-1.5 py-0.5 font-mono text-[12.5px]">winget install AgileBits.1Password.CLI</code>. Poi in 1Password › Impostazioni › Sviluppatore accendi <b>Integra con la CLI di 1Password</b>.</li>}
            <li>Entro un minuto qui sopra il pallino diventa verde (il companion se ne accorge da solo).</li>
          </ol>
        </div>
      )}

      <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-muted">
        <div><b className="text-text">Chiavi SSH.</b> Gli agenti usano ssh, scp e git con le tue chiavi in 1Password: la chiave non lascia mai il tuo PC. La prima firma di ogni chat la approvi tu in Ciccio (vale 15 minuti), poi una finestra sul PC dice utente e server (anche lì 15 minuti, o «Consenti sempre» per quel server) e 1Password chiede Touch ID (Mac) o Windows Hello (Windows). Il PC firma solo accessi SSH, mai altri dati.</div>
        <div><b className="text-text">Segreti.</b> Chiavi API e password passano dallo strumento usa_credenziale: approvi ogni uso, poi una finestra sul PC mostra il riferimento esatto da leggere («Consenti sempre» lo ricorda su quel PC) e 1Password chiede Touch ID o Windows Hello, e l'agente non vede mai il valore (nell'output compare come [NOME nascosto]). Agli agenti dai il riferimento, tipo op://vault/elemento/campo, mai il valore.</div>
        <div>In Ciccio questi permessi non hanno «Consenti sempre» e Ciccio non può approvarli al posto tuo; la finestra sul PC vale anche se il server fosse compromesso.</div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[13.5px] font-semibold">Server raggiungibili in SSH</div>
        {/* Lo stesso modulo di Configurazione › Server SSH: aggiunge e toglie con l'helper root ciccio-ssh-allow. */}
        <SshHostsEditor />
      </div>
    </div>
  );
}
