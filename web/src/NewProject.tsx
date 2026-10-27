import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Orb } from './ui';
import { rise } from './motion';

const slug = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '').slice(0, 63);

/** owner/nome o indirizzo di un repo GitHub (come lo legge il server in newProject.ts). */
const OTHER_REPO = /^((https?:\/\/)?(www\.)?github\.com\/|git@github\.com:)?[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/?$/;

/** Progetto nuovo: nome, descrizione e, se vuoi, cosa deve fare l'agente per iniziare. */
interface GhRepo { name: string; description: string; private: boolean; updatedAt: string; archived: boolean }

export function NewProjectDialog(props: { open: boolean; mode?: 'new' | 'github'; onClose: () => void; onCreated: (agentId: string, chatId: string) => void }) {
  const [tab, setTab] = useState<'new' | 'github'>('new');
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!props.open) return;
    setName(''); setDescription(''); setMessage(''); setError(''); setBusy(false); setPick(null); setQ('');
    setTab(props.mode ?? 'new');
    requestAnimationFrame(() => first.current?.focus());
  }, [props.open, props.mode]);

  // I repo esistenti si chiedono a GitHub solo quando servono.
  useEffect(() => {
    if (!props.open || tab !== 'github' || repos) return;
    void fetch('/api/github/repos').then(async (r) => {
      const d = await r.json();
      if (!r.ok) throw new Error((d as { error?: string }).error ?? `Errore ${r.status}`);
      setRepos(d as GhRepo[]);
    }).catch((e: Error) => { setError(e.message); setRepos([]); });
  }, [props.open, tab, repos]);

  const importRepo = async () => {
    if (!pick) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/projects/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: pick, message }) });
      const data = await res.json() as { agentId?: string; chatId?: string; error?: string };
      if (!res.ok || !data.agentId || !data.chatId) throw new Error(data.error ?? `Errore ${res.status}`);
      setRepos(null);
      props.onCreated(data.agentId, data.chatId);
      props.onClose();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, description, message }) });
      const data = await res.json() as { agentId?: string; chatId?: string; error?: string };
      if (!res.ok || !data.agentId || !data.chatId) throw new Error(data.error ?? `Errore ${res.status}`);
      props.onCreated(data.agentId, data.chatId);
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const field = 'w-full rounded-[10px] border border-line-hi bg-ink px-3 py-2.5 text-[14.5px] text-text outline-none placeholder:text-muted focus:border-acid';
  return (
    <AnimatePresence>
      {props.open && (
        <motion.div key="np" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="cc-viewport z-[55] flex items-end justify-center bg-black/55 p-3 sm:items-center" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }} onClick={() => !busy && props.onClose()}>
          <motion.form {...rise} role="dialog" aria-label="Nuovo progetto" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); if (busy) return; if (tab === 'new' && name.length >= 2) void create(); if (tab === 'github' && pick) void importRepo(); }}
            onKeyDown={(e) => { if (e.key === 'Escape' && !busy) props.onClose(); }}
            style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
            className="cc-scroll flex max-h-full w-full max-w-[520px] flex-col gap-4 overflow-y-auto rounded-[14px] border border-line-hi bg-panel p-5 sm:p-6">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 text-[18px] font-semibold tracking-[-0.01em]">Progetto</h2>
              <div role="tablist" className="mt-2 flex gap-1 rounded-[10px] border border-line p-1">
                {(['new', 'github'] as const).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setError(''); }}
                    className={`flex-1 rounded-[7px] py-1.5 text-[13px] font-medium transition-colors ${tab === t ? 'bg-acid text-ink' : 'text-soft hover:text-text'}`}>
                    {t === 'new' ? 'Nuovo' : 'Da GitHub'}
                  </button>
                ))}
              </div>
              <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-muted">
                {tab === 'new' ? "Ciccio crea il repo privato su GitHub, lo prepara sul server e apre la prima chat con l'agente." : 'Un repo che esiste già su GitHub ma non è ancora in Ciccio (tuo, o owner/nome di un\'organizzazione): lo clono sul server e apro la prima chat.'}
              </p>
            </div>
            {tab === 'github' && (
              <div className="cc-in flex flex-col gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca tra i tuoi repo, o scrivi owner/nome…" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={field} />
                <div className="cc-scroll flex max-h-[240px] flex-col gap-1 overflow-y-auto">
                  {/* Repo di un'organizzazione o di altri: owner/nome o l'indirizzo GitHub, anche se non è nell'elenco. */}
                  {OTHER_REPO.test(q.trim()) && (
                    <button type="button" onClick={() => setPick(q.trim())}
                      className={`flex flex-col rounded-[8px] border px-3 py-2 text-left ${pick === q.trim() ? 'border-acid/70 bg-acid/[.06]' : 'border-line/70 hover:border-line-hi'}`}>
                      <span className="text-[13.5px] font-medium">Aggiungi «{q.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//, '').replace(/\.git$/, '')}»</span>
                      <span className="text-[12px] text-muted">anche di un'organizzazione, se il token GitHub del server la vede</span>
                    </button>
                  )}
                  {repos == null && <span className="flex items-center gap-2 py-3 text-[13px] text-muted"><Orb state="connecting" size={20} label="Chiedo a GitHub" /> Chiedo a GitHub i tuoi repo…</span>}
                  {repos?.filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(q.toLowerCase())).map((r) => (
                    <button key={r.name} type="button" onClick={() => setPick(r.name)}
                      className={`flex flex-col rounded-[8px] border px-3 py-2 text-left ${pick === r.name ? 'border-acid/70 bg-acid/[.06]' : 'border-line/70 hover:border-line-hi'}`}>
                      <span className="flex items-center gap-2 text-[13.5px] font-medium">{r.name}{r.archived && <span className="text-[11px] font-normal text-muted">archiviato</span>}{!r.private && <span className="text-[11px] font-normal text-muted">pubblico</span>}</span>
                      {r.description && <span className="cc-wrap line-clamp-1 text-[12px] text-muted">{r.description}</span>}
                    </button>
                  ))}
                  {repos?.length === 0 && !error && <span className="cc-in py-3 text-[13px] text-muted">Tutti i tuoi repo sono già in Ciccio.</span>}
                </div>
              </div>
            )}
            {tab === 'new' && (<>
            <label className="cc-in flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Nome del repo</span>
              <input ref={first} value={name} onChange={(e) => setName(slug(e.target.value))} placeholder="es. sito-nuovo" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={`${field} font-mono`} />
            </label>
            <label className="cc-in flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Descrizione <span className="font-normal text-muted">· facoltativa</span></span>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Cos'è, in una riga" className={field} />
            </label>
            </>)}
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Primo messaggio all'agente <span className="font-normal text-muted">· facoltativo</span></span>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="es. Prepara un sito Astro con tre pagine: home, servizi, contatti." className={`${field} resize-none`} />
            </label>
            {error && <div className="cc-in cc-wrap text-[13px] leading-snug text-block">{error}</div>}
            <div className="flex items-center justify-end gap-2">
              {busy && <span className="cc-in mr-auto flex items-center gap-2 text-[13px] text-muted"><Orb state="working" size={20} label="Preparo il progetto" /> {tab === 'new' ? 'Creo il repo e la prima chat…' : 'Clono il repo e apro la prima chat…'}</span>}
              <button type="button" onClick={props.onClose} disabled={busy} className="cc-press min-h-11 rounded-[10px] px-4 text-[14px] text-muted hover:text-text disabled:opacity-40">Annulla</button>
              <button type="submit" disabled={busy || (tab === 'new' ? name.length < 2 : !pick)} className="cc-press min-h-11 rounded-[10px] bg-acid px-5 text-[14px] font-semibold text-ink disabled:opacity-40">{tab === 'new' ? 'Crea progetto' : 'Aggiungi a Ciccio'}</button>
            </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
