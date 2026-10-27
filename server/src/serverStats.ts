import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import type { ServerSample, ServerStats } from '../../shared/types.js';

// Prestazioni del VPS per Impostazioni › Server: un campione ogni 30 secondi (CPU, memoria, disco, rete e il
// gruppo di Ciccio, dove girano anche tutti gli agenti), l'ultima ora a 30 secondi e le ultime 24 ore a 5 minuti.
// Tutto letto da /proc e /sys: niente programmi in più. Solo in memoria: a ogni riavvio la storia riparte.

const EVERY_MS = 30_000;
const HOUR = 120;
const DAY = 288;
const DAY_EVERY = 10;

const read = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const num = (s: string | undefined) => (s && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null);

/** Cartella del gruppo di controllo di questo processo (servizio ciccio di systemd: dentro anche gli agenti). */
const CGROUP = (() => {
  const line = read('/proc/self/cgroup').split('\n').find((l) => l.startsWith('0::'));
  return line ? `/sys/fs/cgroup${line.slice(3).trim()}` : null;
})();

function cpuTimes(): { busy: number; total: number } | null {
  const f = read('/proc/stat').split('\n')[0]?.trim().split(/\s+/).slice(1).map(Number);
  if (!f || f.length < 5) return null;
  const idle = f[3] + (f[4] ?? 0);
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

function netBytes(): { rx: number; tx: number } {
  let rx = 0, tx = 0;
  for (const l of read('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = l.split(':');
    if (!rest || /^\s*(lo|docker|br-|veth|tailscale)/.test(name)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  return { rx, tx };
}

function memInfo(): { total: number; available: number; swapTotal: number; swapFree: number } {
  const m: Record<string, number> = {};
  for (const l of read('/proc/meminfo').split('\n')) { const [k, v] = l.split(':'); if (v) m[k] = Number.parseInt(v, 10) * 1024; }
  return { total: m.MemTotal ?? os.totalmem(), available: m.MemAvailable ?? os.freemem(), swapTotal: m.SwapTotal ?? 0, swapFree: m.SwapFree ?? 0 };
}

function groupCpuUsec(): number | null {
  const m = /usage_usec (\d+)/.exec(CGROUP ? read(`${CGROUP}/cpu.stat`) : '');
  return m ? Number(m[1]) : null;
}

/** Tempo di CPU (tick) e memoria di ogni processo, con la cartella di lavoro (gli agenti stanno in ~/projects/<progetto>). */
function processes(): Map<number, { ticks: number; rss: number; name: string; project?: string }> {
  const out = new Map<number, { ticks: number; rss: number; name: string; project?: string }>();
  let pids: string[] = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const pid of pids) {
    const stat = read(`/proc/${pid}/stat`);
    const close = stat.lastIndexOf(')');
    if (close < 0) continue;
    // Dopo il nome tra parentesi: stato è il campo 3, utime e stime 14 e 15, rss (pagine) 24.
    const f = stat.slice(close + 2).split(' ');
    let project: string | undefined;
    try { project = /\/projects\/([\w.-]+)/.exec(fs.readlinkSync(`/proc/${pid}/cwd`))?.[1]; } catch { /* processo di un altro utente */ }
    out.set(Number(pid), { ticks: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * 4096, name: stat.slice(stat.indexOf('(') + 1, close), ...(project ? { project } : {}) });
  }
  return out;
}

let procs: ReturnType<typeof processes> = new Map();
let top: ServerStats['top'] = [];

let prev: { at: number; cpu: ReturnType<typeof cpuTimes>; net: ReturnType<typeof netBytes>; group: number | null } | null = null;
const hour: ServerSample[] = [];
const day: ServerSample[] = [];
let count = 0;

function sample(): ServerSample | null {
  const at = Date.now();
  const cpu = cpuTimes(), net = netBytes(), group = groupCpuUsec();
  const last = prev;
  prev = { at, cpu, net, group };
  const now = processes();
  const before = procs;
  procs = now;
  if (!last) return null;
  const secs = (at - last.at) / 1000;
  // CPU di ogni processo negli ultimi secondi (100 tick al secondo = un core pieno), non la media da quando è partito.
  top = [...now.entries()].map(([pid, p]) => ({ pid, cpu: Math.max(0, (p.ticks - (before.get(pid)?.ticks ?? p.ticks)) / 100 / secs), mem: p.rss, name: p.name, ...(p.project ? { project: p.project } : {}) }))
    .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, 8);
  const mem = memInfo();
  let disk: { used: number; total: number } | null = null;
  try { const s = fs.statfsSync(config.projectsDir); disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bavail) * s.bsize }; } catch { /* niente disco */ }
  return {
    at,
    cpu: cpu && last.cpu && cpu.total > last.cpu.total ? (cpu.busy - last.cpu.busy) / (cpu.total - last.cpu.total) : 0,
    load: os.loadavg()[0],
    memUsed: mem.total - mem.available,
    swapUsed: mem.swapTotal - mem.swapFree,
    diskUsed: disk?.used ?? 0,
    rx: Math.max(0, (net.rx - last.net.rx) / secs),
    tx: Math.max(0, (net.tx - last.net.tx) / secs),
    groupMem: num(CGROUP ? read(`${CGROUP}/memory.current`) : undefined) ?? 0,
    // Microsecondi di CPU del gruppo nel periodo, in core usati (1 = un core pieno).
    groupCpu: group != null && last.group != null ? (group - last.group) / 1e6 / secs : 0,
  };
}

function tick() {
  const s = sample();
  if (!s) return;
  hour.push(s); if (hour.length > HOUR) hour.shift();
  // Ogni 5 minuti la media dei campioni: il grafico di un giorno mostra l'andamento, non i picchi di un istante.
  if (++count % DAY_EVERY === 0) {
    const part = hour.slice(-DAY_EVERY);
    const avg = (k: keyof ServerSample) => part.reduce((a, x) => a + (x[k] as number), 0) / part.length;
    day.push({ ...s, cpu: avg('cpu'), load: avg('load'), rx: avg('rx'), tx: avg('tx'), groupCpu: avg('groupCpu') });
    if (day.length > DAY) day.shift();
  }
}

export function startServerStats() {
  sample();
  setTimeout(tick, 2000);
  setInterval(tick, EVERY_MS).unref();
}

/** Il servizio systemd è attivo (anche per la pagina Configurazione). */
export function active(unit: string, user: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('systemctl', [...(user ? ['--user'] : []), 'is-active', '--quiet', unit], { timeout: 3000 }, (err) => resolve(!err));
  });
}

/** Il servizio è installato (systemd conosce l'unità): quelli facoltativi non installati non compaiono. */
function installed(unit: string, user: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('systemctl', [...(user ? ['--user'] : []), 'show', unit, '-p', 'LoadState', '--value'], { timeout: 3000 }, (err, out) => resolve(!err && String(out).trim() === 'loaded'));
  });
}

const SERVICES: { unit: string; label: string; user: boolean; optional?: boolean }[] = [
  { unit: 'ciccio', label: 'Ciccio', user: true },
  { unit: 'ciccio-voice', label: 'Voce', user: true, optional: true },
  { unit: 'ciccio-display', label: 'Schermo degli agenti', user: true, optional: true },
  { unit: 'caddy', label: 'Caddy (HTTPS)', user: false, optional: true },
  { unit: 'tinyproxy', label: 'Firewall in uscita', user: false, optional: true },
];

export async function serverStats(): Promise<ServerStats> {
  const mem = memInfo();
  let diskTotal = 0;
  try { const s = fs.statfsSync(config.projectsDir); diskTotal = s.blocks * s.bsize; } catch { /* niente disco */ }
  const cpuMax = (CGROUP ? read(`${CGROUP}/cpu.max`) : '').trim().split(/\s+/);
  const services = (await Promise.all(SERVICES.map(async (x) => (x.optional && !(await installed(x.unit, x.user)) ? null : { label: x.label, active: await active(x.unit, x.user) }))))
    .filter((x) => x != null);
  return {
    cores: os.cpus().length,
    memTotal: mem.total,
    swapTotal: mem.swapTotal,
    diskTotal,
    uptime: Math.round(os.uptime()),
    groupMemMax: num(CGROUP ? read(`${CGROUP}/memory.max`) : undefined),
    groupCpuMax: cpuMax[0] && cpuMax[0] !== 'max' ? Number(cpuMax[0]) / Number(cpuMax[1]) : null,
    hour: [...hour],
    day: [...day],
    top: [...top],
    services,
  };
}
