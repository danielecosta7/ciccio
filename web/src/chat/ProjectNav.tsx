import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'motion/react';
import { api, timeAgo } from '../api';
import { STATUS, runRing } from '../ui';
import { quick, smooth } from '../motion';
import type { AgentView, ChatView } from '../../../shared/types';
import { byWork, recency } from '../order';
import { haptic } from '../haptic';
import { useCoarse } from '../viewport';

/** Larghezza dei comandi che compaiono scorrendo una chat verso sinistra (Rinomina, Archivia). */
const ACTIONS_W = 148;

/**
 * Chat sul telefono: si apre col tocco; scorrendo verso sinistra (o tenendo premuto) compaiono Rinomina e Archivia.
 * Archiviare non cancella i messaggi.
 */
function TouchChatRow({ chat, active, onOpen }: { chat: ChatView; active: boolean; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number; long: boolean } | null>(null);
  // Posizione della riga: dopo ogni trascinamento torna sempre a uno dei due punti (chiusa o aperta), anche se lo stato non cambia.
  const x = useMotionValue(0);
  const reveal = (v: boolean) => { if (v && !open) haptic('tap'); setOpen(v); void animate(x, v ? -ACTIONS_W : 0, smooth); };
  // Pulsanti sotto la riga visibili solo mentre la riga si sposta: da chiusa l'arancio di «Archivia» trapelava dagli angoli arrotondati.
  const actionsOpacity = useTransform(x, [-6, 0], [1, 0]);
  return (
    <motion.div layout="position" transition={smooth}
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 44, transition: smooth }} exit={{ opacity: 0, height: 0, transition: quick }}
      className="relative flex-none overflow-hidden rounded-[9px]">
      <motion.div className="absolute inset-y-0 right-0 flex" style={{ width: ACTIONS_W, opacity: actionsOpacity }} aria-hidden={!open}>
        <button type="button" tabIndex={open ? 0 : -1} onClick={() => { reveal(false); setEditing(true); }}
          className="flex-1 bg-line-hi text-[12.5px] font-medium text-text">Rinomina</button>
        <button type="button" tabIndex={open ? 0 : -1} onClick={() => { haptic('warn'); reveal(false); void api.archiveChat(chat.id); }}
          className="flex-1 bg-wait text-[12.5px] font-semibold text-ink">Archivia</button>
      </motion.div>
      <motion.div drag={editing ? false : 'x'} dragConstraints={{ left: -ACTIONS_W, right: 0 }} dragElastic={0.06} dragMomentum={false} dragDirectionLock
        style={{ x }}
        onDragEnd={(_, i) => reveal(open ? i.offset.x < 40 : i.offset.x < -50)}
        className={`relative flex h-full items-center gap-2.5 rounded-[9px] border bg-ink pr-2 pl-3 ${runRing(chat.status)} ${active ? 'cc-here border-acid/40 !bg-panel-hi' : 'border-transparent'}`}>
        <span className={`h-1.5 w-1.5 flex-none ${chat.status === 'wait' ? 'cc-sq-pulse' : ''}`} style={{ background: chat.status === 'idle' ? 'oklch(0.45 0 0)' : STATUS[chat.status].color }} />
        {editing ? (
          <ChatTitleEdit chat={chat} className="min-h-9 flex-1 text-[16px]" onDone={() => setEditing(false)} />
        ) : (
          <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
            onPointerDown={(e) => { const t = setTimeout(() => { if (press.current) { press.current.long = true; reveal(true); } }, 480); press.current = { t, x: e.clientX, y: e.clientY, long: false }; }}
            onPointerMove={(e) => { if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) clearTimeout(press.current.t); }}
            onPointerUp={() => { if (press.current) clearTimeout(press.current.t); }}
            onPointerCancel={() => { if (press.current) clearTimeout(press.current.t); press.current = null; }}
            onContextMenu={(e) => e.preventDefault()}
            onClick={() => { const long = press.current?.long; press.current = null; if (long) return; if (open) reveal(false); else onOpen(); }}>
            <span className={`min-w-0 flex-1 truncate text-[15px] ${active ? 'text-text' : 'text-soft'}`}>{chat.title}</span>
            {chat.running
              ? <span className="cc-dots3 flex-none" aria-label="al lavoro"><i /><i /><i /></span>
              : <span className="flex-none font-mono text-[11px] text-muted">{timeAgo(recency(chat) || chat.createdAt)}</span>}
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}


function loadOpen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('ciccio.navOpen') ?? '[]') as string[]); } catch { return new Set(); }
}

/** Titolo di una chat modificabile sul posto: doppio clic o matita, Invio salva, Esc annulla. */
export function ChatTitleEdit({ chat, className = '', onDone }: { chat: ChatView; className?: string; onDone: () => void }) {
  const [value, setValue] = useState(chat.title);
  const save = () => {
    onDone();
    if (value.trim() && value.trim() !== chat.title) void api.renameChat(chat.id, value.trim());
  };
  return (
    <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onBlur={save}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') onDone(); }}
      aria-label="Nome della chat"
      className={`min-w-0 rounded-[6px] border border-acid bg-ink px-1.5 py-0.5 text-text outline-none ${className}`} />
  );
}

function ChatRowItem({ chat, active, onOpen }: { chat: ChatView; active: boolean; onOpen: () => void }) {
  const [editing, setEditing] = useState(false);
  // Il contorno in movimento dice cosa fa la chat (al lavoro o ti aspetta), anche se non la stai guardando;
  // quella aperta si riconosce dal velo verde (cc-here) e da un bordo fermo.
  return (
    <motion.div layout="position" transition={smooth}
      initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 36, transition: smooth }} exit={{ opacity: 0, height: 0, transition: quick }}
      className={`group relative flex h-9 flex-none items-center overflow-hidden gap-2 rounded-[7px] border pr-1 pl-2.5 ${runRing(chat.status)} ${active ? 'cc-here border-acid/40 bg-panel-hi' : 'border-transparent hover:bg-panel'}`}>
      <span className={`h-1.5 w-1.5 flex-none ${chat.status === 'wait' ? 'cc-sq-pulse' : ''}`} style={{ background: chat.status === 'idle' ? 'oklch(0.45 0 0)' : STATUS[chat.status].color }} />
      {editing ? (
        <ChatTitleEdit chat={chat} className="flex-1 text-[13px]" onDone={() => setEditing(false)} />
      ) : (
        // Al passaggio del mouse il titolo sfuma poco prima dei pulsanti: sotto di loro resta lo sfondo vero della riga
        // (anche il velo arancio di chi aspetta te), niente riquadro pieno che lo copre.
        <button type="button" onClick={onOpen} onDoubleClick={() => setEditing(true)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left group-focus-within:[mask-image:linear-gradient(to_right,#000_calc(100%-70px),transparent_calc(100%-50px))] group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%-70px),transparent_calc(100%-50px))]" title={`${chat.title} · doppio clic per rinominare`}>
          <span className={`min-w-0 flex-1 truncate text-[13px] ${active ? 'text-text' : 'text-soft'}`}>{chat.title}</span>
          {chat.running
            ? <span className="cc-dots3 flex-none" aria-label="al lavoro"><i /><i /><i /></span>
            : <span className="flex-none font-mono text-[10.5px] text-muted group-focus-within:invisible group-hover:invisible">{timeAgo(recency(chat) || chat.createdAt)}</span>}
        </button>
      )}
      {!editing && (
        // Sopra l'ora, senza spostare nulla: la riga resta alta uguale e il titolo non si accorcia.
        <span className={`pointer-events-none absolute inset-y-px right-1 flex items-center pl-3 opacity-0 transition-opacity duration-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100`}>
          <button type="button" onClick={() => setEditing(true)} aria-label={`Rinomina ${chat.title}`} title="Rinomina"
            className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:text-text">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg>
          </button>
          <button type="button" onClick={() => void api.archiveChat(chat.id)} aria-label={`Archivia ${chat.title}`} title="Archivia (i messaggi restano)"
            className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:text-text">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M6 7v12h12V7M10 11h4" /></svg>
          </button>
        </span>
      )}
    </motion.div>
  );
}

/** Progetti come in Claude Code per Mac: ognuno si apre a fisarmonica e mostra le sue chat. */
export function ProjectNav(props: {
  agents: AgentView[];
  /** Progetto e chat aperti (null nella scheda Chat del telefono, che non ha una chat aperta). */
  currentAgentId: string | null;
  currentChatId: string | null;
  onOpenChat: (agentId: string, chatId: string) => void;
  onNewChat: (agentId: string) => void;
  onNewProject: () => void;
  /** Pagina intera (scheda Chat del telefono): scorre con la finestra, niente pulsante «Nuovo progetto» qui dentro. */
  page?: boolean;
}) {
  const coarse = useCoarse();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(loadOpen);
  const save = (next: Set<string>) => { setOpen(next); try { localStorage.setItem('ciccio.navOpen', JSON.stringify([...next])); } catch { /* memoria non disponibile */ } };
  const toggle = (id: string) => { const n = new Set(open); if (n.has(id)) n.delete(id); else n.add(id); save(n); };

  // Il progetto che stai guardando è sempre aperto.
  useEffect(() => {
    const id = props.currentAgentId;
    if (id) setOpen((o) => (o.has(id) ? o : new Set(o).add(id)));
  }, [props.currentAgentId]);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return props.agents
      .filter((a) => !a.hidden || a.id === props.currentAgentId)
      .map((a) => ({ a, chats: [...(t && !`${a.name} ${a.id}`.toLowerCase().includes(t) ? a.chats.filter((c) => c.title.toLowerCase().includes(t)) : a.chats)].sort(byWork) }))
      .filter(({ a, chats }) => !t || chats.length > 0 || `${a.name} ${a.id}`.toLowerCase().includes(t))
      .sort((x, y) => byWork(x.a, y.a));
  }, [props.agents, q, props.currentAgentId]);

  return (
    <>
      {!props.page && <button type="button" onClick={props.onNewProject}
        className="cc-press mx-3 mb-2 flex min-h-9 pointer-coarse:min-h-11 items-center justify-center gap-1.5 rounded-[8px] border border-dashed border-acid/50 text-[13px] font-medium text-acid hover:bg-acid/[.06]">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        Nuovo progetto
      </button>}
      <label className={`mx-3 mb-2 flex items-center border border-line bg-ink ${props.page ? 'min-h-11 gap-2 rounded-[12px] bg-panel px-3' : 'min-h-9 rounded-[8px] px-2.5 pointer-coarse:min-h-11'}`}>
        {props.page && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" className="flex-none text-muted"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></svg>}
        <span className="sr-only">Cerca progetto o chat</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca progetto o chat…" className={`w-full bg-transparent outline-none placeholder:text-muted ${props.page ? 'text-[15px]' : 'text-[13px]'}`} />
      </label>
      <div className={props.page ? 'px-2 pb-3' : 'cc-scroll flex-1 overflow-y-auto px-2 pb-3'}>
        <AnimatePresence initial={false}>
        {list.map(({ a, chats }) => {
          const isOpen = open.has(a.id) || !!q.trim();
          const here = a.id === props.currentAgentId;
          return (
            <motion.div key={a.id} layout="position" transition={smooth} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: quick }} className="mb-0.5">
              {/* Progetto chiuso: il contorno delle sue chat passa a lui, così non ti sfugge chi lavora o ti aspetta. */}
              <div className={`group relative flex items-center gap-1 rounded-[8px] border border-transparent pr-1 ${isOpen ? '' : runRing(a.status)} ${here ? 'bg-panel/60' : 'hover:bg-panel'}`}>
                <button type="button" onClick={() => toggle(a.id)} aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 text-left pointer-coarse:min-h-11">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`flex-none text-muted transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}><path d="M9 6l6 6-6 6" /></svg>
                  <span className={`h-2 w-2 flex-none ${a.status === 'wait' ? 'cc-sq-pulse' : ''}`} style={{ background: STATUS[a.status].color }} />
                  <span className={`min-w-0 flex-1 truncate font-medium ${props.page ? 'text-[15.5px]' : 'text-[13.5px]'} ${here ? 'text-text' : 'text-soft'}`}>{a.name}</span>
                  {a.chats.length > 0 && <span className="flex-none font-mono text-[10.5px] text-muted">{a.chats.length}</span>}
                </button>
                <button type="button" onClick={() => props.onNewChat(a.id)} aria-label={`Nuova chat in ${a.name}`} title="Nuova chat"
                  className={`flex h-7 w-7 flex-none items-center justify-center rounded-[6px] text-muted hover:bg-panel-hi hover:text-acid transition-opacity duration-150 pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:opacity-100 ${here || isOpen ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              </div>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div key="chats" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1, transition: smooth }} exit={{ height: 0, opacity: 0, transition: quick }} className="overflow-hidden">
                    <div className="flex flex-col gap-0.5 py-0.5 pl-4">
                      <AnimatePresence initial={false}>
                      {chats.map((c) => (coarse
                        ? <TouchChatRow key={c.id} chat={c} active={c.id === props.currentChatId} onOpen={() => props.onOpenChat(a.id, c.id)} />
                        : <ChatRowItem key={c.id} chat={c} active={c.id === props.currentChatId} onOpen={() => props.onOpenChat(a.id, c.id)} />
                      ))}
                      </AnimatePresence>
                      {chats.length === 0 && (
                        <button type="button" onClick={() => props.onNewChat(a.id)} className="cc-in rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-panel hover:text-text pointer-coarse:min-h-11 pointer-coarse:text-[14px]">+ Inizia una chat</button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          );
        })}
        </AnimatePresence>
      </div>
    </>
  );
}
