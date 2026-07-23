import type { AgentActivityMessage } from "../types.ts";

export interface SessionMessagesState {
  hasOlderMessagesBySessionId: Readonly<Record<string, boolean>>;
  messagesBySessionId: Readonly<
    Record<string, readonly AgentActivityMessage[]>
  >;
}
