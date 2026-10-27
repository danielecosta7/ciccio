import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { decide } from './policy.js';
import { readSecretOnPc } from './companion.js';
import { OP_REF } from '../../shared/companion.js';
import { OWNER } from './config.js';
import { sandboxAvailable, sandboxed, toolEnv, toolTmp } from './toolSandbox.js';
import { confine, type Scope } from './confine.js';

// usa_credenziale: l'agente usa un segreto di 1Password in un comando senza mai vederlo.
// L'utente approva ogni uso in Ciccio (anche in Auto e Ignora, mai «sempre»), poi il companion del Mac
// fa op read e 1Password chiede Touch ID. Il valore vive solo nell'ambiente del comando e nell'output
// è sostituito da [NOME nascosto]. Non finisce nel modello, nella chat o nel database.
// Il comando gira fuori dalla sandbox di Claude Code (lo lancia il server), quindi lo chiude bubblewrap come gli
// strumenti su misura (toolSandbox.ts): altri progetti, dati di Ciccio e credenziali nascosti, scrivibili solo il
// repo, le cache e una cartella temporanea; ambiente filtrato (niente chiavi del server), più i segreti chiesti.

export const CREDENTIALS_SERVER = 'ciccio_credenziali';
export const CREDENTIAL_TOOL = `mcp__${CREDENTIALS_SERVER}__usa_credenziale`;

const MAX_OUTPUT = 60_000;
const TIMEOUT_MS = 5 * 60_000;
/** Comando e motivo stanno interi nella card: oltre questi limiti si rifiuta, invece di tagliarli. */
export const MAX_COMMAND = 2000;
export const MAX_REASON = 200;

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError });

/** Ogni forma in cui un segreto può ricomparire nell'output: com'è, in base64, codificato per gli URL. */
function variants(value: string): string[] {
  const out = new Set([value, Buffer.from(value).toString('base64').replace(/=+$/, ''), encodeURIComponent(value)]);
  return [...out].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

function mask(output: string, secrets: { name: string; value: string }[]): string {
  let s = output;
  for (const { name, value } of secrets) for (const v of variants(value)) s = s.split(v).join(`[${name} nascosto]`);
  return s;
}

function runCommand(command: string, scope: Scope, vars: Record<string, string>, signal: AbortSignal): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const tmp = toolTmp();
  const { command: program, args } = sandboxed(scope.project, scope.dir, tmp, ['bash', '-c', command]);
  return new Promise((resolve) => {
    // Anche i programmi Node escono dal proxy del firewall, come nelle sessioni.
    const proxy: Record<string, string> = process.env.NODE_USE_ENV_PROXY ? { NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY } : {};
    const child = spawn(program, args, { cwd: scope.dir, env: toolEnv(tmp, { ...proxy, ...vars }), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '';
    let timedOut = false;
    const add = (b: Buffer) => { if (output.length < MAX_OUTPUT * 2) output += b.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    // Si chiude tutto il gruppo di processi (bwrap e quello che ha lanciato).
    const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* già chiuso */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, TIMEOUT_MS);
    signal.addEventListener('abort', kill, { once: true });
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', kill); fs.rm(tmp, { recursive: true, force: true }, () => undefined); };
    child.on('error', (e) => { output += `\n${e.message}`; });
    child.on('close', (code) => { done(); resolve({ code, output, timedOut }); });
  });
}

/**
 * Richiesta che non si può mostrare intera nella card: comando o motivo troppo lunghi, motivo su più righe.
 * null = va bene. La card deve far vedere esattamente cosa gira, quindi niente tagli: si rifiuta.
 */
export function credentialProblem(input: Record<string, unknown>): string | null {
  const comando = typeof input.comando === 'string' ? input.comando : '';
  const motivo = typeof input.motivo === 'string' ? input.motivo : '';
  if (comando.length > MAX_COMMAND) return `Comando troppo lungo (${comando.length} caratteri, al massimo ${MAX_COMMAND}): mettilo in uno script del repo e lancia quello.`;
  if (motivo.length > MAX_REASON || /[\r\n]/.test(motivo)) return `Il motivo è una riga sola di al massimo ${MAX_REASON} caratteri.`;
  const refs = Array.isArray(input.segreti) ? (input.segreti as { riferimento?: unknown }[]) : [];
  if (refs.some((r) => typeof r?.riferimento !== 'string' || r.riferimento.length > 200 || /[\r\n]/.test(r.riferimento))) return 'Riferimento non valido: serve op://vault/elemento/campo, su una riga.';
  return null;
}

/** Server MCP della sessione: un'istanza per giro, con la cartella del repo. */
export function credentialsServer(scope: Scope, signal: AbortSignal): McpSdkServerConfigWithInstance {
  const cfg = createSdkMcpServer({
    name: CREDENTIALS_SERVER,
    version: '1.0.0',
    tools: [
      tool('usa_credenziale',
        "Esegue un comando bash nella cartella del repo con uno o più segreti di 1Password in variabili d'ambiente, senza che tu ne veda il valore. " +
        `${OWNER} approva ogni uso in Ciccio e conferma sul suo PC (una finestra con il riferimento esatto, poi Touch ID sul Mac, Windows Hello su Windows).Nel comando usa le variabili ($NOME), mai i valori; ` +
        "nell'output i segreti compaiono come [NOME nascosto]. Non stampare, salvare su file o mandare i segreti altrove. " +
        'Il comando gira in una sandbox come gli altri: scrive solo nel repo e in $TMPDIR, la rete passa dal proxy. ' +
        "Per SSH non serve: le chiavi SSH di 1Password sono già disponibili con ssh, scp e git.",
        {
          segreti: z.array(z.object({
            variabile: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/).describe('nome della variabile, es. SERVIZIO_API_KEY'),
            riferimento: z.string().describe('riferimento 1Password op://vault/elemento/campo'),
          })).min(1).max(5),
          comando: z.string().min(1).describe(`comando bash che usa le variabili, es. curl -H "api-key: $SERVIZIO_API_KEY" https://… (al massimo ${MAX_COMMAND} caratteri)`),
          motivo: z.string().min(3).describe(`a cosa serve, in una riga di al massimo ${MAX_REASON} caratteri: lo legge ${OWNER} quando approva`),
        },
        async ({ segreti, comando, motivo }) => {
          // Il rifiuto per lunghezza lo dà già canUseTool, prima della card (credentialProblem); qui per sicurezza.
          const problem = credentialProblem({ segreti, comando, motivo });
          if (problem) return text(problem, true);
          const box = sandboxAvailable();
          if (!box.ok) return text(box.reason, true);
          for (const s of segreti) if (!OP_REF.test(s.riferimento)) return text(`Riferimento non valido: ${s.riferimento}. Serve op://vault/elemento/campo.`, true);
          // Le regole che valgono sempre (es. niente push su main, git e gh solo sul repo del progetto) valgono anche qui.
          const verdict = confine('Bash', { command: comando }, scope) ?? decide('bypass', 'Bash', { command: comando }, scope.dir);
          if (verdict.action === 'deny') return text(`Comando bloccato: ${verdict.reason}`, true);
          const secrets: { name: string; value: string }[] = [];
          try {
            for (const s of segreti) secrets.push({ name: s.variabile, value: await readSecretOnPc(s.riferimento, signal, motivo) });
          } catch (err) {
            return text(`1Password: ${(err as Error).message}`, true);
          }
          const vars = Object.fromEntries(secrets.map((s) => [s.name, s.value]));
          const r = await runCommand(comando, scope, vars, signal);
          let out = mask(r.output, secrets);
          if (out.length > MAX_OUTPUT) out = `${out.slice(0, MAX_OUTPUT)}\n… output tagliato`;
          secrets.length = 0;
          const head = r.timedOut ? 'Comando fermato dopo 5 minuti.' : `Uscita ${r.code ?? '?'}.`;
          return text(`${head}\n${out.trim() || '(nessun output)'}`, r.code !== 0);
        }),
    ],
  });
  // Ogni chiamata passa da canUseTool (che chiede sempre all'utente), anche se una regola delle impostazioni la coprirebbe.
  return { ...cfg, tools: [{ name: 'usa_credenziale', permission_policy: 'always_ask' as const }] } as McpSdkServerConfigWithInstance;
}
