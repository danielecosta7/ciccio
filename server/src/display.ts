import fs from 'node:fs';

// Schermo virtuale condiviso degli agenti (servizio ciccio-display, Xvfb :50): i programmi grafici senza finestra
// (render di OpenSCAD, PyVista, FreeCAD) ne hanno bisogno, e nella sandbox xvfb-run non riesce ad accenderne uno
// suo perché /tmp è in sola lettura. Si collegano a questo attraverso il suo socket in /tmp/.X11-unix.
const DISPLAY = ':50';
const SOCKET = '/tmp/.X11-unix/X50';

/** DISPLAY per l'ambiente di un agente, solo se lo schermo è acceso (altrimenti i programmi darebbero un errore più confuso). */
export function agentDisplay(): { DISPLAY: string } | Record<string, never> {
  try { return fs.statSync(SOCKET).isSocket() ? { DISPLAY } : {}; } catch { return {}; }
}
