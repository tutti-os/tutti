import {
  createContext,
  useContext,
  useSyncExternalStore,
  type JSX,
  type PropsWithChildren
} from "react";
import {
  createAgentQueuedPromptRuntime,
  type AgentQueuedPromptRuntime
} from "./agentQueuedPromptRuntimeCore";
import type {
  AgentQueuedPromptClaim,
  AgentQueuedPromptClaimResult,
  AgentQueuedPromptQueueSnapshot,
  AgentQueuedPromptRetryBlock,
  AgentQueuedPromptSnapshot
} from "./agentQueuedPromptRuntimeCore";

export { createAgentQueuedPromptRuntime };
export type {
  AgentQueuedPromptClaim,
  AgentQueuedPromptClaimResult,
  AgentQueuedPromptQueueSnapshot,
  AgentQueuedPromptRetryBlock,
  AgentQueuedPromptRuntime,
  AgentQueuedPromptSnapshot
};

const AgentQueuedPromptRuntimeContext =
  createContext<AgentQueuedPromptRuntime | null>(null);

let currentAgentQueuedPromptRuntime: AgentQueuedPromptRuntime | null = null;

export interface AgentQueuedPromptRuntimeProviderProps extends PropsWithChildren {
  runtime?: AgentQueuedPromptRuntime | null;
}

export function AgentQueuedPromptRuntimeProvider({
  children,
  runtime
}: AgentQueuedPromptRuntimeProviderProps): JSX.Element {
  currentAgentQueuedPromptRuntime = runtime ?? null;
  return (
    <AgentQueuedPromptRuntimeContext.Provider value={runtime ?? null}>
      {children}
    </AgentQueuedPromptRuntimeContext.Provider>
  );
}

export function useAgentQueuedPromptRuntime(): AgentQueuedPromptRuntime {
  const runtime =
    useContext(AgentQueuedPromptRuntimeContext) ??
    getTestAgentQueuedPromptRuntime();
  if (!runtime) {
    throw new Error(
      "AgentQueuedPromptRuntimeProvider is missing an AgentQueuedPromptRuntime instance."
    );
  }
  return runtime;
}

export function useAgentQueuedPromptSessionSnapshot(input: {
  agentSessionId: string | null;
  workspaceId: string;
}): AgentQueuedPromptQueueSnapshot | null {
  const runtime = useAgentQueuedPromptRuntime();
  const workspaceId = input.workspaceId.trim();
  const agentSessionId = input.agentSessionId?.trim() ?? "";
  return useSyncExternalStore(
    runtime.subscribe,
    () =>
      agentSessionId
        ? runtime.getSessionSnapshot({ workspaceId, agentSessionId })
        : null,
    () =>
      agentSessionId
        ? runtime.getSessionSnapshot({ workspaceId, agentSessionId })
        : null
  );
}

export function resetAgentQueuedPromptRuntimeForTests(): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentQueuedPromptRuntime = null;
  }
}

export function setAgentQueuedPromptRuntimeForTests(
  runtime: AgentQueuedPromptRuntime | null
): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentQueuedPromptRuntime = runtime;
  }
}

function getTestAgentQueuedPromptRuntime(): AgentQueuedPromptRuntime | null {
  if (process.env.NODE_ENV !== "test") {
    return null;
  }
  if (currentAgentQueuedPromptRuntime) {
    return currentAgentQueuedPromptRuntime;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const testRuntime = (
    window as unknown as Window & {
      agentQueuedPromptRuntime?: AgentQueuedPromptRuntime;
    }
  ).agentQueuedPromptRuntime;
  return testRuntime ?? null;
}
