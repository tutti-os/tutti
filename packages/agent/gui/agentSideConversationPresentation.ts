import type { AgentGUISideConversationSurfaceProps } from "./agent-gui/agentGuiNode/view/AgentGUISideConversationPane";

export interface AgentGUISideConversationProjection {
  sideAgentSessionId: string;
  sourceAgentSessionId: string;
  surfaceProps: AgentGUISideConversationSurfaceProps;
  close(): Promise<void>;
}

export interface AgentGUISideConversationIdentity {
  sideAgentSessionId: string;
  sourceAgentSessionId: string;
}

export interface AgentGUISideConversationPresentation {
  getSnapshot(): AgentGUISideConversationProjection | null;
  getIdentitySnapshot(): AgentGUISideConversationIdentity | null;
  publish(projection: AgentGUISideConversationProjection | null): void;
  subscribe(listener: () => void): () => void;
  subscribeIdentity(listener: () => void): () => void;
}

export function createAgentGUISideConversationPresentation(): AgentGUISideConversationPresentation {
  let projection: AgentGUISideConversationProjection | null = null;
  let identity: AgentGUISideConversationIdentity | null = null;
  const listeners = new Set<() => void>();
  const identityListeners = new Set<() => void>();

  return {
    getSnapshot: () => projection,
    getIdentitySnapshot: () => identity,
    publish(nextProjection) {
      if (projection === nextProjection) return;
      const nextIdentity = nextProjection
        ? {
            sideAgentSessionId: nextProjection.sideAgentSessionId,
            sourceAgentSessionId: nextProjection.sourceAgentSessionId
          }
        : null;
      const identityChanged =
        identity?.sideAgentSessionId !== nextIdentity?.sideAgentSessionId ||
        identity?.sourceAgentSessionId !== nextIdentity?.sourceAgentSessionId;
      projection = nextProjection;
      if (identityChanged) {
        identity = nextIdentity;
        for (const listener of identityListeners) listener();
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeIdentity(listener) {
      identityListeners.add(listener);
      return () => identityListeners.delete(listener);
    }
  };
}
