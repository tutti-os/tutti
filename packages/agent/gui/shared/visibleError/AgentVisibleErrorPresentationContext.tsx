import {
  createContext,
  useContext,
  type JSX,
  type PropsWithChildren
} from "react";
import type { AgentVisibleErrorOverrides } from "../agentEnv/agentErrorPresentation";

const AgentVisibleErrorPresentationContext =
  createContext<AgentVisibleErrorOverrides | null>(null);

export function AgentVisibleErrorPresentationProvider({
  children,
  value
}: PropsWithChildren<{
  value?: AgentVisibleErrorOverrides | null;
}>): JSX.Element {
  return (
    <AgentVisibleErrorPresentationContext.Provider value={value ?? null}>
      {children}
    </AgentVisibleErrorPresentationContext.Provider>
  );
}

export function useAgentVisibleErrorPresentationOverrides(): AgentVisibleErrorOverrides | null {
  return useContext(AgentVisibleErrorPresentationContext);
}
