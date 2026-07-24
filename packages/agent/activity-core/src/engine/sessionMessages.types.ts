import type { AgentActivitySessionMessageWindow } from "../messageWindow.types.ts";
import type { AgentActivityMessage } from "../types.ts";

export interface SessionMessagesState {
  messagesBySessionId: Readonly<
    Record<string, readonly AgentActivityMessage[]>
  >;
  windowsBySessionId: Readonly<
    Record<string, Readonly<AgentActivitySessionMessageWindow>>
  >;
}
