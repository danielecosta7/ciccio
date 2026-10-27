import path from 'node:path';
import { execFile } from 'node:child_process';
import { expandPath, updateConfig } from './config.js';
import { ONCE_MS, type AccessAnswer, type AccessRequest, type FileServerOptions } from './file.js';
import { dim, green, log, yellow } from './log.js';

// Richieste di accesso del server «file» (chiedi_accesso) e proposte degli agenti (server «comandi»):
// le finestre sul PC e il salvataggio nella config.
// Decide solo chi è davanti al PC: Ciccio e gli agenti possono chiedere, mai allargare le cartelle da soli.
// Windows: finestra di PowerShell con la casella «Solo lettura». Mac: display dialog di osascript (tre
// pulsanti, niente casella: vale il tipo di accesso chiesto). Altrove: lo strumento non c'è.

const TITLE = 'Un agente chiede una cartella';
const BUTTONS = ['Consenti questa volta', 'Consenti sempre', 'No'] as const;

function message(req: AccessRequest, withCheckbox: boolean): string {
  const minutes = Math.max(1, Math.round(req.timeoutMs / 60_000));
  const mode = withCheckbox
    ? 'Con «Solo lettura» può elencarla e copiarne i file nelle altre cartelle consentite, ma non scriverci; senza, può anche copiarci dentro e crearvi cartelle.'
    : req.solaLettura
      ? 'Accesso in sola lettura: può elencarla e copiarne i file nelle altre cartelle consentite, ma non scriverci.'
      : 'Accesso anche in scrittura: può copiarci dentro file e crearvi cartelle (mai cancellare).';
  return [
    `Cartella${req.esiste ? '' : ' (non esiste ancora)'}:\n${req.cartella}`,
    `Motivo scritto dall'agente:\n«${req.motivo}»`,
    mode,
    `«Consenti questa volta» vale finché il companion resta acceso, al massimo ${ONCE_MS / 3_600_000} ore; «Consenti sempre» la aggiunge alla config di questo PC. Senza risposta entro ${minutes} minuti: no.`,
  ].join('\n\n');
}

const pick = (button: string | undefined, solaLettura: boolean): AccessAnswer => {
  if (button === BUTTONS[0]) return { scelta: 'una_volta', solaLettura };
  if (button === BUTTONS[1]) return { scelta: 'sempre', solaLettura };
  return { scelta: 'no' };
};

async function askWindows(req: AccessRequest, signal: AbortSignal): Promise<AccessAnswer> {
  const { choose } = await import('./windows-ui.js');
  // La finestra compare in primo piano mentre si sta magari scrivendo altrove: da tastiera (Invio, Esc,
  // spazio) si può solo dire «No»; i consensi si premono col mouse, e solo dopo un secondo.
  const r = await choose(TITLE, message(req, true), [...BUTTONS], {
    check: { label: 'Solo lettura (copiare da qui, non scriverci)', checked: req.solaLettura },
    defaultButton: 2, cancelButton: 2, mouseOnly: [0, 1], signal,
  });
  if (signal.aborted) return { scelta: 'nessuna_risposta' };
  // Chiusa con la X: come «No».
  return pick(BUTTONS[r.choice], r.checked ?? req.solaLettura);
}

/** Su Mac: display dialog (gli argomenti passano come argv, così nessun testo dell'agente diventa codice AppleScript). */
const OSA = [
  'on run argv',
  'activate',
  'set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"No", "Consenti sempre", "Consenti questa volta"} default button "No" with icon caution giving up after ((item 3 of argv) as integer)',
  'if gave up of r then return "-"',
  'return button returned of r',
  'end run',
];

function askMac(req: AccessRequest, signal: AbortSignal): Promise<AccessAnswer> {
  return new Promise((resolve) => {
    const args = [...OSA.flatMap((l) => ['-e', l]), TITLE, message(req, false), String(Math.ceil(req.timeoutMs / 1000))];
    execFile('osascript', args, { signal, encoding: 'utf8' }, (err, stdout) => {
      if (err || stdout.trim() === '-') { resolve({ scelta: 'nessuna_risposta' }); return; }
      resolve(pick(stdout.trim(), req.solaLettura));
    });
  });
}

/** La finestra di questo PC, con una riga nel registro per richiesta e risposta; undefined dove non c'è. */
export function pcAsk(): FileServerOptions['ask'] {
  const ask = process.platform === 'win32' ? askWindows : process.platform === 'darwin' ? askMac : undefined;
  if (!ask) return undefined;
  return async (req, signal) => {
    log(`accesso · richiesta per ${req.cartella} ${dim(req.solaLettura ? '(sola lettura)' : '(anche scrittura)')}`);
    const a = await ask(req, signal).catch((err: Error) => { log(yellow(`accesso · finestra non riuscita: ${err.message}`)); return { scelta: 'nessuna_risposta' } as const; });
    const what = a.scelta === 'una_volta' || a.scelta === 'sempre' ? green(`${a.scelta === 'sempre' ? 'consentita sempre' : 'consentita questa volta'}${a.solaLettura ? ' (sola lettura)' : ''}`) : a.scelta === 'no' ? 'rifiutata' : 'nessuna risposta';
    log(`accesso · ${req.cartella}: ${what}`);
    return a;
  };
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * «Consenti sempre»: aggiunge la cartella alle roots della voce `key` (il nome com'è nella config), lasciando
 * tutto il resto com'è. Se la cartella c'è già (es. in sola lettura) ne cambia solo l'accesso.
 */
export function addRootToConfig(configPath: string, key: string, root: { path: string; solaLettura?: true }) {
  updateConfig(configPath, (raw) => {
    const roots = raw.mcpServers?.[key]?.roots;
    if (!Array.isArray(roots)) throw new Error(`nella config non c'è la voce «${key}» con le cartelle`);
    const pathOf = (r: unknown) => (typeof r === 'string' ? r : typeof (r as { path?: unknown })?.path === 'string' ? (r as { path: string }).path : null);
    const i = roots.findIndex((r) => { const p = pathOf(r); return p != null && norm(path.resolve(expandPath(p))) === norm(path.resolve(root.path)); });
    if (i < 0) roots.push(root);
    else {
      const old = roots[i];
      const merged: Record<string, unknown> = typeof old === 'string' ? { path: old } : { ...(old as object) };
      if (root.solaLettura) merged.solaLettura = true; else delete merged.solaLettura;
      roots[i] = merged;
    }
  });
}

// ── Proposte degli agenti (comandi consentiti e strumenti nuovi) ─────────
// Due pulsanti: «Consenti sempre» (scrive nella config) e «No». Come per le cartelle, da tastiera si può
// solo dire no, e «Consenti sempre» si preme col mouse dopo un secondo.

export interface ConfirmRequest { title: string; text: string; timeoutMs: number }
export type ConfirmAnswer = 'sì' | 'no' | 'nessuna_risposta';
const YES = 'Consenti sempre';

const OSA2 = [
  'on run argv',
  'activate',
  'set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"No", "Consenti sempre"} default button "No" with icon caution giving up after ((item 3 of argv) as integer)',
  'if gave up of r then return "-"',
  'return button returned of r',
  'end run',
];

/** La finestra di conferma di questo PC, con una riga nel registro per risposta; undefined dove non c'è. */
export function pcConfirm(): ((req: ConfirmRequest, signal: AbortSignal) => Promise<ConfirmAnswer>) | undefined {
  if (process.platform === 'win32') {
    return async (req, signal) => {
      const { choose } = await import('./windows-ui.js');
      const r = await choose(req.title, req.text, [YES, 'No'], { defaultButton: 1, cancelButton: 1, mouseOnly: [0], signal });
      if (signal.aborted) return 'nessuna_risposta';
      return r.choice === 0 ? 'sì' : 'no';
    };
  }
  if (process.platform === 'darwin') {
    return (req, signal) => new Promise((resolve) => {
      const args = [...OSA2.flatMap((l) => ['-e', l]), req.title, req.text, String(Math.ceil(req.timeoutMs / 1000))];
      execFile('osascript', args, { signal, encoding: 'utf8' }, (err, stdout) => {
        if (err || stdout.trim() === '-') { resolve('nessuna_risposta'); return; }
        resolve(stdout.trim() === YES ? 'sì' : 'no');
      });
    });
  }
  return undefined;
}

// ── Domande con più risposte (consensi di 1Password, consensi.ts) ────────
// Come le altre: i consensi si premono col mouse dopo un secondo, da tastiera solo l'ultima risposta (il «No»),
// che vale anche se la finestra si chiude o il tempo scade.

export interface ChoiceRequest { title: string; text: string; buttons: string[]; timeoutMs: number }
/** La risposta scelta (una di `buttons`), o null: chiusa, tempo scaduto, annullata. */
export type PcChoose = (req: ChoiceRequest, signal: AbortSignal) => Promise<string | null>;

const OSA_CHOOSE = [
  'on run argv',
  'activate',
  'set bs to items 4 thru -1 of argv',
  'set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons bs default button (item 1 of bs) with icon caution giving up after ((item 3 of argv) as integer)',
  'if gave up of r then return "-"',
  'return button returned of r',
  'end run',
];

/** La finestra con più risposte di questo PC; undefined dove non c'è (allora vale solo quello già consentito). */
export function pcChoose(): PcChoose | undefined {
  if (process.platform === 'win32') {
    return async (req, signal) => {
      const { choose } = await import('./windows-ui.js');
      const no = req.buttons.length - 1;
      const r = await choose(req.title, req.text, req.buttons, { defaultButton: no, cancelButton: no, mouseOnly: req.buttons.map((_, i) => i).filter((i) => i !== no), signal });
      return signal.aborted ? null : req.buttons[r.choice] ?? null;
    };
  }
  if (process.platform === 'darwin') {
    // display dialog: al massimo tre pulsanti; il «No» (l'ultimo) va a sinistra ed è quello di Invio.
    return (req, signal) => new Promise((resolve) => {
      const order = [req.buttons[req.buttons.length - 1], ...req.buttons.slice(0, -1).reverse()];
      const args = [...OSA_CHOOSE.flatMap((l) => ['-e', l]), req.title, req.text, String(Math.ceil(req.timeoutMs / 1000)), ...order];
      execFile('osascript', args, { signal, encoding: 'utf8' }, (err, stdout) => {
        const b = typeof stdout === 'string' ? stdout.trim() : '';
        resolve(err || !b || b === '-' || !req.buttons.includes(b) ? null : b);
      });
    });
  }
  return undefined;
}
