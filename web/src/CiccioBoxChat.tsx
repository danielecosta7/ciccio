import { useEffect, useState } from 'react';
import { Transcript } from './chat/Transcript';
import { ChatContainerContent, ChatContainerRoot, ScrollButton } from './chat/ChatContainer';
import type { Approval, ChatMessage, LiveState } from '../../shared/types';

/**
 * La chat con Ciccio dentro il suo riquadro in dashboard: la conversazione recente per intero, che scorre e resta in
 * fondo come le altre chat. Prima c'era solo l'ultima risposta, tagliata a quattro righe.
 */
export function CiccioBoxChat(props: {
  messages: ChatMessage[];
  approvals: Approval[];
  running: boolean;
  live?: LiveState;
  onDecide: (id: string, allow: boolean, always?: boolean) => void;
  onOpenFile: (path: string) => void;
  /** Indirizzo di un file nominato da Ciccio, per Copia e Scarica. */
  fileUrl: (path: string) => string | null;
  onOpenChat: (agentId: string, chatId: string) => void;
}) {
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => { setSince((s) => (props.running ? (s ?? Date.now()) : null)); }, [props.running]);
  const last = props.messages[props.messages.length - 1];
  const news = `${props.messages.length}:${last?.id}:${props.approvals.length}`;
  return (
    // Riempie lo spazio che resta nel riquadro di Ciccio: l'altezza la decide il riepilogo accanto (la chat è in
    // assoluto, così non allunga la fila e non spinge giù le schede degli agenti). Da sola, su telefono, ha un minimo.
    <div className="relative min-h-[300px] flex-1 overflow-hidden rounded-[12px] border border-line bg-ink sm:min-h-[180px]">
      <ChatContainerRoot className="absolute inset-0">
        <ChatContainerContent scrollClassName="cc-scroll overscroll-contain">
          <Transcript
            ciccio
            messages={props.messages.slice(-80)}
            approvals={props.approvals}
            agentName="Ciccio"
            running={props.running}
            live={props.live}
            runningSince={since}
            onDecide={props.onDecide}
            onOpenFile={props.onOpenFile}
            fileUrl={props.fileUrl}
            onOpenChat={props.onOpenChat}
            empty="Chiedimi come stanno gli agenti, passa un lavoro a uno di loro o fatti leggere posta e calendario."
          />
        </ChatContainerContent>
        <ScrollButton signal={news} className="bottom-2" />
      </ChatContainerRoot>
    </div>
  );
}
