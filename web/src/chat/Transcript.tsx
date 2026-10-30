import { Fragment, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { collapse, quick, smooth } from '../motion';
import { AlwaysLabel, ApprovalDetail, Orb, alwaysOnly, alwaysRule, approvalParts, toolLabel } from '../ui';
import { Markdown } from './Markdown';
import { SentAttachments } from './attachments';
import { onlyPermissions } from '../QuestionPanel';
import { copyText } from './fileActions';
import { CopyButton } from './CopyButton';
import { ToolRow, shortTool, toolMeta } from './Tool';
import { Reasoning, TextShimmer } from './Reasoning';
import { Steps, groupSteps, stepKey } from './Steps';
import { SourceTitles, searchLinks } from './Source';
import { SystemMessage } from './SystemMessage';
import { type Approval, type ChatMessage, type LiveState, type TodoMeta } from '../../../shared/types';

function TodoBlock({ meta, latest }: { meta: TodoMeta; latest: boolean }) {
  const done = meta.todos.filter((t) => t.status === 'completed').length;
  if (!latest) return <div className="cc-in text-[12px] text-muted">Compiti aggiornati · {done} di {meta.todos.length}</div>;
  return (
    <div className="cc-in flex flex-col gap-1.5 rounded-[10px] border border-line bg-[oklch(0.15_0_0)] px-3.5 py-3 text-[13.5px]">
      <div className="text-[12px] font-medium text-muted">Compiti · {done} di {meta.todos.length}</div>
      {meta.todos.map((t, i) => (
        <div key={i} className={`flex items-center gap-2.5 ${t.status === 'completed' ? 'text-muted line-through' : 'text-text'}`}>
          {t.status === 'completed' && <span className="h-3 w-3 flex-none bg-done" />}
          {t.status === 'in_progress' && <span className="flex h-3 w-3 flex-none items-center justify-center bg-acid" aria-label="in corso" />}
          {t.status === 'pending' && <span className="h-3 w-3 flex-none border-[1.5px] border-line-hi" />}
          <span>{t.content}</span>
        </div>
      ))}
    </div>
  );
}

function clock(ts: number) {
  return new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
}

/** Chi risponde: iniziale in un quadrato, nome e ora. Apre ogni turno di risposta. */
function TurnHeader({ name, ts }: { name: string; ts?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-6 w-6 flex-none items-center justify-center rounded-[6px] border border-line-hi bg-panel-hi font-mono text-[11.5px] font-semibold text-acid" aria-hidden="true">
        {name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '·'}
      </span>
      <span className="text-[13px] font-semibold text-text">{name}</span>
      {ts && <span className="font-mono text-[11px] text-muted">{clock(ts)}</span>}
    </div>
  );
}

const LIVE_LABEL = { thinking: 'Sto pensando', tool: 'Uso', writing: 'Scrivo', idle: 'Al lavoro' } as const;
const LIVE_ORB = { thinking: 'solving', tool: 'working', writing: 'composing', idle: 'solving' } as const;

/**
 * Mentre l'agente lavora (Thinking bar di prompt-kit): orb, la fase col testo che luccica e i secondi.
 * I secondi hanno un orologio loro: durante un sub-agente o un comando lungo non arrivano eventi per minuti, e
 * dove chi contiene la riga non si ridisegnava da solo (il riquadro di Ciccio in dashboard) il contatore restava
 * fermo e sembrava tutto bloccato.
 */
function LiveRow({ live, since }: { live?: LiveState; since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const secs = since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
  // A schermo li conta il CSS (styles.css, .cc-secs), partendo da quanto è già passato quando la riga compare.
  const delay = useMemo(() => (since ? -Math.max(0, (Date.now() - since) / 1000) : 0), [since]);
  const phase = live?.phase && live.phase !== 'idle' ? live.phase : 'thinking';
  const label = phase === 'tool' ? `${LIVE_LABEL.tool} ${live?.tool ? shortTool(live.tool) : 'uno strumento'}` : LIVE_LABEL[phase];
  return (
    <div className="cc-in flex items-center gap-3 text-[13.5px] text-muted" aria-live="polite">
      <span className="flex h-8 w-8 items-center justify-center"><Orb state={LIVE_ORB[phase]} size={32} label={label} /></span>
      <TextShimmer className="min-w-0 truncate font-medium">{label}…</TextShimmer>
      <span className="cc-secs relative flex-none font-mono text-[12px]" style={{ animationDelay: `${delay}s` }}><span className="cc-secs-js">{secs} s</span></span>
    </div>
  );
}

/** Il testo e il ragionamento in diretta, mostrati come messaggi dell'agente in fondo alla conversazione. */
const LIVE_ID = -1;
const LIVE_THINK_ID = -2;

export function Transcript(props: {
  messages: ChatMessage[];
  approvals: Approval[];
  agentName: string;
  running: boolean;
  runningSince: number | null;
  live?: LiveState;
  onDecide: (id: string, allow: boolean, always?: boolean) => void;
  onOpenFile: (path: string) => void;
  /** Indirizzo dei file del repo, per immagini e link relativi nelle risposte. */
  fileBase?: string;
  /** Indirizzo di un file nominato o scritto (Copia e Scarica); senza, si ricava da fileBase. */
  fileUrl?: (path: string) => string | null;
  /** Apre la chat di un agente da un avviso di Ciccio. */
  onOpenChat?: (agentId: string, chatId: string) => void;
  /** Chat con Ciccio: le sue risposte sono testo pieno, non note di sistema; impaginazione stretta. */
  ciccio?: boolean;
  empty?: string;
  /** Telefono: i permessi in attesa stanno sopra il campo di testo (PermissionDock), non in fondo alla conversazione. */
  dockPermissions?: boolean;
}) {
  const { approvals } = props;
  // Titoli delle pagine trovate dalle ricerche della chat: l'anteprima delle fonti nelle risposte li mostra.
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of props.messages) if (m.meta?.kind === 'tool' && m.meta.tool === 'WebSearch') for (const l of searchLinks(m.meta.output ?? '')) map.set(l.url, l.title);
    return map;
  }, [props.messages]);
  const assistant = (m: ChatMessage) => m.role === 'agent' || (props.ciccio && m.role === 'ciccio');

  const mine = (m: ChatMessage) => m.role === 'user' || (!props.ciccio && m.role === 'ciccio');
  // Il server salva il messaggio e solo dopo azzera il testo in diretta (due eventi), e il testo in diretta arriva a
  // pezzi ogni 80 ms: appena l'ultimo testo salvato del turno è quello in diretta (o lo completa), non si mostra più.
  const liveText = props.running ? props.live?.text.trim() ?? '' : '';
  const liveSaved = (() => {
    if (!liveText) return true;
    for (let k = props.messages.length - 1; k >= 0 && !mine(props.messages[k]); k -= 1) {
      if (!assistant(props.messages[k]) || !props.messages[k].text.trim()) continue;
      const t = props.messages[k].text.trim();
      return t.startsWith(liveText) || (t.length > 40 && liveText.endsWith(t));
    }
    return false;
  })();
  // Il ragionamento in diretta, finché non arriva il testo: stessa regola, col ragionamento salvato del turno.
  const liveThinking = props.running && !liveText ? props.live?.thinking?.trim() ?? '' : '';
  const thinkingSaved = (() => {
    if (!liveThinking) return true;
    for (let k = props.messages.length - 1; k >= 0 && !mine(props.messages[k]); k -= 1) {
      if (props.messages[k].role !== 'thinking') continue;
      return props.messages[k].text.trim().startsWith(liveThinking);
    }
    return false;
  })();
  // Il testo in diretta è un messaggio come gli altri, in fondo: stesso aspetto e stessa altezza di quando sarà salvato.
  const messages = [...props.messages];
  if (!thinkingSaved) messages.push({ id: LIVE_THINK_ID, chatId: '', agentId: '', role: 'thinking', text: liveThinking, ts: Date.now() });
  if (!liveSaved) messages.push({ id: LIVE_ID, chatId: '', agentId: '', role: props.ciccio ? 'ciccio' : 'agent', text: liveText, ts: Date.now() });
  const lastTodo = [...messages].reverse().find((m) => m.meta?.kind === 'todo')?.id;
  /** Note di sistema (livello cambiato, permesso approvato…): non aprono e non chiudono un turno. */
  const isNote = (m: ChatMessage) => m.role === 'tool' && !toolMeta(m);
  const lastReal = [...messages].reverse().find((m) => !isNote(m));
  const fileBase = props.fileBase;
  const fileUrl = props.fileUrl ?? (fileBase ? (p: string) => `${fileBase}${encodeURIComponent(p)}` : undefined);
  /** Testo del turno di risposta che finisce al messaggio i (null se il turno continua): per il «copia» in fondo. */
  const turnText = (i: number): string | null => {
    let next = i + 1;
    while (next < messages.length && isNote(messages[next])) next += 1;
    if (next < messages.length ? !mine(messages[next]) : props.running) return null;
    const parts: string[] = [];
    for (let k = i; k >= 0 && !mine(messages[k]); k -= 1) if (assistant(messages[k]) && messages[k].text.trim()) parts.unshift(messages[k].text.trim());
    return parts.length ? parts.join('\n\n') : null;
  };
  /** Il «copia» va sotto l'ultimo testo del turno, anche se dopo vengono solo passaggi: mai da solo sotto i passaggi. */
  const copyAt = (i: number): string | null => {
    let end = i;
    while (end + 1 < messages.length && !mine(messages[end + 1])) {
      end += 1;
      if (assistant(messages[end]) && messages[end].text.trim()) return null;
    }
    return turnText(end);
  };
  const lastMine = !lastReal || mine(lastReal);

  /** Un passaggio dentro il blocco: strumento o ragionamento (`current`: quello a cui l'agente sta lavorando). */
  function renderStep(m: ChatMessage, current: boolean) {
    if (m.role === 'thinking') return <Reasoning text={m.text} streaming={m.id === LIVE_THINK_ID} />;
    if (!toolMeta(m)) return <SystemMessage text={m.text} compact />;
    return <ToolRow m={m} onOpenFile={props.onOpenFile} fileUrl={fileUrl} current={current} />;
  }

  function renderMessage(m: ChatMessage) {
        if (m.meta?.kind === 'notice') {
          const n = m.meta;
          // Risposta già data direttamente nella chat: l'avviso non aspetta più niente.
          const settled = n.superseded === true;
          const color = settled ? 'text-muted' : n.tone === 'wait' ? 'text-wait' : n.tone === 'block' ? 'text-block' : 'text-done';
          return (
            <div key={m.id} className={`cc-in flex flex-col gap-1.5 rounded-[10px] border border-line bg-panel-hi px-3 py-2.5 ${settled ? 'opacity-60' : ''}`}>
              <div className="flex items-center gap-2 text-[12px]">
                <span className={`h-2 w-2 flex-none ${settled ? 'bg-muted' : n.tone === 'wait' ? 'cc-sq-pulse bg-wait' : n.tone === 'block' ? 'bg-block' : 'bg-done'}`} />
                <span className={`font-semibold ${color}`}>{n.agentId}</span>
                <span className="min-w-0 truncate text-muted">· {n.chatTitle}</span>
                {settled && <span className="ml-auto flex-none text-muted">già gestita in chat</span>}
              </div>
              <div className="text-[14px] leading-relaxed text-soft">{m.text}</div>
              {props.onOpenChat && (
                <button type="button" onClick={() => props.onOpenChat!(n.agentId, n.chatId)} className="self-start text-[12.5px] font-medium text-acid hover:underline">Apri la chat →</button>
              )}
            </div>
          );
        }
        if (m.role === 'user') {
          const att = m.meta?.kind === 'user' ? m.meta.attachments : [];
          return (
            <div key={m.id} className="cc-in-right flex max-w-[82%] flex-col items-end gap-2 self-end">
              <SentAttachments atts={att} fileBase={props.fileBase} onOpen={props.onOpenFile} />
              {/* Formattato come le risposte: elenchi numerati e puntati, grassetto, codice. */}
              <div className="break-words rounded-[14px_14px_4px_14px] border border-[oklch(0.4_0.07_128)] bg-[oklch(0.25_0.035_128)] px-3.5 py-2.5 text-[14.5px] leading-relaxed text-text"><Markdown text={m.text} /></div>
              <span className="pr-1 font-mono text-[11px] text-muted">{m.meta?.kind === 'user' && m.meta.routine ? `⏱ routine «${m.meta.routine}»` : 'Tu'} · {clock(m.ts)}</span>
            </div>
          );
        }
        // Senza animazione d'entrata: il testo è già comparso in diretta, al suo posto.
        if (assistant(m)) return <div className={`text-[14.5px] leading-relaxed text-soft ${m.id === LIVE_ID ? 'cc-typing' : ''}`}><Markdown text={m.text} fileBase={props.fileBase} onOpenFile={props.onOpenFile} fileUrl={fileUrl} /></div>;
        if (m.role === 'ciccio') {
          return (
            <div key={m.id} className="cc-in-right flex max-w-[82%] flex-col items-end gap-1 self-end">
              <span className="text-[12px] font-semibold text-acid">Da Ciccio</span>
              <div className="whitespace-pre-wrap break-words rounded-[14px_14px_4px_14px] border border-acid/25 bg-acid/[.06] px-3.5 py-2.5 text-[14px] leading-relaxed text-soft">{m.text}</div>
            </div>
          );
        }
        if (m.role === 'error') {
          return <div key={m.id} className="cc-in whitespace-pre-wrap rounded-[10px] border border-block/40 bg-block/[.07] px-3.5 py-2.5 text-[13.5px] text-[#FFB0A5]">{m.text}</div>;
        }
        if (m.role === 'todo' && m.meta?.kind === 'todo') return <TodoBlock key={m.id} meta={m.meta} latest={m.id === lastTodo} />;
        if (m.role === 'tool' && toolMeta(m)) return <ToolRow key={m.id} m={m} onOpenFile={props.onOpenFile} fileUrl={fileUrl} />;
        return <SystemMessage key={m.id} text={m.text} />;
  }

  return (
    <SourceTitles.Provider value={titles}>
    <div className={`cc-selectable mx-auto flex w-full flex-col gap-4 ${props.ciccio ? 'px-4 py-4' : 'max-w-[880px] px-4 py-6 sm:px-6'}`}>
      <AnimatePresence initial={false}>
      {messages.length === 0 && (
        <motion.div key="empty" {...collapse} className="overflow-hidden">
          <div className="py-16 text-center text-[14px] text-muted">{props.empty ?? `Scrivi a ${props.agentName} per iniziare. Puoi allegare file di qualsiasi formato.`}</div>
        </motion.div>
      )}
      </AnimatePresence>
      {groupSteps(messages).map((g) => {
        const m = g.items[0];
        if (!g.run && (mine(m) || isNote(m))) return renderMessage(m);
        // Ogni turno di risposta si apre con chi parla; la colonna resta rientrata fino al tuo prossimo messaggio.
        let prev = g.first - 1;
        while (prev >= 0 && isNote(messages[prev])) prev -= 1;
        const starts = prev < 0 || mine(messages[prev]);
        const done = g.run ? null : copyAt(g.last);
        const before = messages[g.first - 1];
        // Il testo in diretta e il messaggio salvato che lo sostituisce hanno la stessa chiave (il messaggio che li
        // precede): è lo stesso elemento che cambia solo testo, senza rimontare, quindi non cambia altezza né sfarfalla.
        // Lo stesso per i passaggi: il blocco resta quello mentre cresce.
        const key = g.run ? `passi:${before?.id ?? ''}` : assistant(m) ? `dopo:${before?.id ?? ''}` : m.id;
        // Il gruppo di passaggi in fondo, mentre l'agente lavora e non sta ancora scrivendo: mostra il passo in corso.
        const live = g.run && props.running && g.last === messages.length - 1;
        const tools = g.run && g.items.some((x) => toolMeta(x));
        return (
          <div key={key} className="flex w-full flex-col gap-2">
            {starts && <TurnHeader name={props.agentName} ts={m.ts} />}
            {/* Ricevuto: dal bordo sinistro, con spazio a destra; i tuoi messaggi stanno a destra. */}
            <div className="flex min-w-0 max-w-[92%] flex-col gap-2 self-start sm:max-w-[88%]">
              {!g.run ? renderMessage(m)
                : tools ? <Steps items={g.items} live={live} renderStep={renderStep} />
                // Solo ragionamento (prima di rispondere): il blocco «Ragionamento» da solo, senza titolo dei passaggi.
                : g.items.map((x, i) => <Fragment key={stepKey(x, g.items[i - 1])}>{renderStep(x, false)}</Fragment>)}
            </div>
            {/* Fine del turno: copia tutto il testo della risposta, come nella app di Claude. */}
            {done && <CopyButton copy={() => copyText(done)} label="Copia la risposta" className="-mt-1 -ml-1.5 h-8 w-8 self-start rounded-[7px] hover:bg-panel-hi" />}
          </div>
        );
      })}

      <AnimatePresence initial={false}>
      {/* Deciso: si chiude in altezza (anche lo spazio sopra), così la chat lo segue senza scatti verso l'alto. */}
      {(props.dockPermissions ? [] : onlyPermissions(approvals)).map((a) => (
        <motion.div key={a.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: smooth }} exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, borderWidth: 0, marginTop: -16, transition: quick }}
          className="cc-glow flex flex-col gap-2.5 overflow-hidden rounded-[12px] border border-wait/45 bg-wait/[.06] p-3.5">
          <div className="cc-wrap text-[13px] font-semibold text-wait">Permesso richiesto · {toolLabel(a.tool)}</div>
          <ApprovalDetail a={a} />
          {approvalParts(a).reason && <div className="text-[12px] text-muted">{approvalParts(a).reason}</div>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => props.onDecide(a.id, true, alwaysOnly(a.tool))} className="cc-press min-h-10 rounded-[10px] bg-acid px-4 text-[13.5px] font-semibold text-ink">{alwaysOnly(a.tool) ? 'Consenti sempre' : 'Consenti'}</button>
            {alwaysRule(a) && (
            <button type="button" onClick={() => props.onDecide(a.id, true, true)} className="cc-press min-h-10 min-w-0 max-w-full rounded-[10px] border border-line-hi px-4 text-[13.5px]"><AlwaysLabel rule={alwaysRule(a)!} label="Consenti sempre" /></button>
            )}
            <button type="button" onClick={() => props.onDecide(a.id, false)} className="cc-press min-h-10 rounded-[10px] border border-line-hi px-4 text-[13.5px]">Rifiuta</button>
          </div>
        </motion.div>
      ))}
      </AnimatePresence>

      {/* «Sto pensando…»: entra e, a fine giro o quando arriva un permesso da dare (o una domanda), si chiude in altezza. */}
      <AnimatePresence initial={false}>
      {props.running && approvals.length === 0 && (
        <motion.div key="live" {...collapse} className="flex flex-col gap-2 overflow-hidden">
          {lastMine && <TurnHeader name={props.agentName} />}
          <div className="min-w-0 max-w-[92%] self-start sm:max-w-[88%]"><LiveRow live={props.live} since={props.runningSince} /></div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
    </SourceTitles.Provider>
  );
}
