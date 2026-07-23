import {
  createContext,
  useContext,
  type JSX,
  type PropsWithChildren
} from "react";
import type { AgentGUIMembershipAccessState } from "../../agent-gui/agentGuiNode/accountMenuState";

export interface AgentGUICommercePresentation {
  membershipAccess?: AgentGUIMembershipAccessState;
  planUrl?: string | null;
}

const AgentCommercePresentationContext =
  createContext<AgentGUICommercePresentation | null>(null);

export function AgentCommercePresentationProvider({
  children,
  value
}: PropsWithChildren<{
  value?: AgentGUICommercePresentation | null;
}>): JSX.Element {
  return (
    <AgentCommercePresentationContext.Provider value={value ?? null}>
      {children}
    </AgentCommercePresentationContext.Provider>
  );
}

export function useAgentCommercePresentation(): AgentGUICommercePresentation | null {
  return useContext(AgentCommercePresentationContext);
}
