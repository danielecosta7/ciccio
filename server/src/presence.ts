// Quali chat sta guardando l'utente in questo momento (una per scheda aperta).
// Serve a Ciccio per non avvisarlo di una risposta che ha già sotto gli occhi.

const viewing = new Map<object, string | null>();

export function setViewing(socket: object, chatId: string | null) {
  viewing.set(socket, chatId);
}

export function dropSocket(socket: object) {
  viewing.delete(socket);
}

export function isViewing(chatId: string): boolean {
  for (const id of viewing.values()) if (id === chatId) return true;
  return false;
}
