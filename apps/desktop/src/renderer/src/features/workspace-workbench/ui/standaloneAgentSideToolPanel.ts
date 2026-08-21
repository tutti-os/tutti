import type { AgentGUISideConversationIdentity } from "@tutti-os/agent-gui";

export interface StandaloneAgentSideTabIdentity extends AgentGUISideConversationIdentity {
  tabId: string;
}

export function resolveStandaloneAgentSideTabReconciliation(input: {
  current: StandaloneAgentSideTabIdentity | null;
  next: AgentGUISideConversationIdentity | null;
}): {
  closeTabId: string | null;
  open: AgentGUISideConversationIdentity | null;
} {
  if (!input.next) {
    return { closeTabId: input.current?.tabId ?? null, open: null };
  }
  if (
    input.current?.sideAgentSessionId === input.next.sideAgentSessionId &&
    input.current.sourceAgentSessionId === input.next.sourceAgentSessionId
  ) {
    return { closeTabId: null, open: null };
  }
  return {
    closeTabId: input.current?.tabId ?? null,
    open: input.next
  };
}

export function shouldCloseStandaloneAgentSide(input: {
  closingTabId: string;
  current: StandaloneAgentSideTabIdentity | null;
  projection: AgentGUISideConversationIdentity | null;
}): boolean {
  return Boolean(
    input.current?.tabId === input.closingTabId &&
    input.projection?.sideAgentSessionId === input.current.sideAgentSessionId &&
    input.projection.sourceAgentSessionId === input.current.sourceAgentSessionId
  );
}

export function shouldRestoreStandaloneAgentSide(input: {
  closing: AgentGUISideConversationIdentity;
  projection: AgentGUISideConversationIdentity | null;
}): boolean {
  return Boolean(
    input.projection?.sideAgentSessionId === input.closing.sideAgentSessionId &&
    input.projection.sourceAgentSessionId === input.closing.sourceAgentSessionId
  );
}

export async function closeStandaloneAgentSideWithRecovery(input: {
  closing: AgentGUISideConversationIdentity;
  close(): Promise<void>;
  getProjection(): AgentGUISideConversationIdentity | null;
  restore(identity: AgentGUISideConversationIdentity): void;
}): Promise<void> {
  try {
    await input.close();
  } catch {
    if (
      shouldRestoreStandaloneAgentSide({
        closing: input.closing,
        projection: input.getProjection()
      })
    ) {
      input.restore(input.closing);
    }
  }
}
