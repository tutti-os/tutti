import type { AgentActivityMessage } from "../types.ts";
import type { AgentActivitySessionMessageWindow } from "../messageWindow.types.ts";
import type { AgentSessionEngineState } from "./types.ts";

const EMPTY_MESSAGES: readonly AgentActivityMessage[] = [];

export function selectSessionMessagesById(
  state: AgentSessionEngineState
): Readonly<Record<string, readonly AgentActivityMessage[]>> {
  return state.sessionMessages.messagesBySessionId;
}

export function selectSessionMessages(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): readonly AgentActivityMessage[] {
  const id = agentSessionId?.trim() ?? "";
  if (!id) return EMPTY_MESSAGES;
  return state.sessionMessages.messagesBySessionId[id] ?? EMPTY_MESSAGES;
}

export function selectSessionMessageWindow(
  state: AgentSessionEngineState,
  agentSessionId: string | null | undefined
): Readonly<AgentActivitySessionMessageWindow> | null {
  const id = agentSessionId?.trim() ?? "";
  if (!id) return null;
  return state.sessionMessages.windowsBySessionId[id] ?? null;
}
