import { createContext, useContext, type JSX, type ReactNode } from "react";
import type { AgentMessageMarkdownAgentTarget } from "./agentTargetPresentation";

export {
  resolveAgentTargetPresentation,
  type AgentMessageMarkdownAgentTarget
} from "./agentTargetPresentation";

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
