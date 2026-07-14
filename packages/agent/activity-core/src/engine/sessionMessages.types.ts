import type { AgentActivityMessage } from "../types.ts";

export interface SessionMessagesState {
  messagesBySessionId: Readonly<
    Record<string, readonly AgentActivityMessage[]>
  >;
}
