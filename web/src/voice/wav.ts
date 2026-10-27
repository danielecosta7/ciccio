/** WAV mono 16 kHz, 16 bit: il formato che vuole il servizio voce. */
export function encodeWav(pcm: Int16Array, sampleRate = 16000): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

export async function transcribe(pcm: Int16Array, partial = false): Promise<string> {
  const res = await fetch(`/api/voice/stt${partial ? '?partial=1' : ''}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encodeWav(pcm) });
  if (res.status === 401) window.dispatchEvent(new Event('ciccio:auth'));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Errore ${res.status}`);
  return ((await res.json()) as { text: string }).text.trim();
}
