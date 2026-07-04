import { createContext, useContext, type JSX, type ReactNode } from "react";

export interface AgentMessageMarkdownAgentTarget {
  agentTargetId: string;
  iconUrl?: string | null;
  name?: string | null;
  provider?: string | null;
  workspaceId?: string | null;
}

const EMPTY_AGENT_TARGETS: readonly AgentMessageMarkdownAgentTarget[] =
  Object.freeze([]);

const AgentTargetPresentationContext =
  createContext<readonly AgentMessageMarkdownAgentTarget[]>(
    EMPTY_AGENT_TARGETS
  );

export function AgentTargetPresentationProvider({
  agentTargets,
  children
}: {
  agentTargets: readonly AgentMessageMarkdownAgentTarget[];
  children: ReactNode;
}): JSX.Element {
  return (
    <AgentTargetPresentationContext.Provider value={agentTargets}>
      {children}
    </AgentTargetPresentationContext.Provider>
  );
}

export function useAgentTargetPresentations(): readonly AgentMessageMarkdownAgentTarget[] {
  return useContext(AgentTargetPresentationContext);
}

export function resolveAgentTargetPresentation(input: {
  agentTargetId: string;
  agentTargets: readonly AgentMessageMarkdownAgentTarget[];
  workspaceId?: string | null;
}): AgentMessageMarkdownAgentTarget | null {
  const agentTargetId = input.agentTargetId.trim();
  if (!agentTargetId) {
    return null;
  }
  const workspaceId = input.workspaceId?.trim() ?? "";
  return (
    input.agentTargets.find(
      (target) =>
        target.agentTargetId.trim() === agentTargetId &&
        (target.workspaceId?.trim() ?? "") === workspaceId
    ) ??
    input.agentTargets.find(
      (target) => target.agentTargetId.trim() === agentTargetId
    ) ??
    null
  );
}
