import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type JSX,
  type PropsWithChildren
} from "react";
import {
  toAgentHostRuntimeApi,
  type AgentHostInputApi,
  type AgentHostRuntimeApi
} from "./host/agentHostApi";
import {
  AgentActivityRuntimeProvider,
  type AgentActivityRuntime
} from "./agentActivityRuntime";
import { WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN } from "./shared/workspaceAgentActivityTypes";

const AgentActivityHostContext = createContext<AgentHostRuntimeApi | null>(
  null
);

let currentAgentHostApi: AgentHostRuntimeApi | null = null;

// Host APIs indexed by their runtime origin, mirroring the runtime registry.
// Read-state persistence resolves the host API by the query's origin so a
// local window persists to the local host and a shared/cloud window persists to
// its own cloud host — each backend keyed by (roomId, userId) with no origin
// needed on the record itself.
const hostApiByOrigin = new Map<string, AgentHostRuntimeApi>();

function resolveHostOrigin(
  runtime: AgentActivityRuntime | null | undefined
): string {
  return (
    runtime?.origin?.trim() || WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN
  );
}

export interface AgentActivityHostProviderProps extends PropsWithChildren {
  agentActivityRuntime?: AgentActivityRuntime | null;
  agentHostApi?: AgentHostInputApi | null;
}

export function AgentActivityHostProvider({
  agentActivityRuntime,
  agentHostApi,
  children
}: AgentActivityHostProviderProps): JSX.Element {
  const resolvedAgentHostApi = useMemo(
    () => (agentHostApi ? toAgentHostRuntimeApi(agentHostApi) : null),
    [agentHostApi]
  );
  currentAgentHostApi = resolvedAgentHostApi;
  const origin = resolveHostOrigin(agentActivityRuntime);
  // Register during render to close the gap before the effect runs; the effect
  // owns cleanup on unmount.
  if (resolvedAgentHostApi) {
    hostApiByOrigin.set(origin, resolvedAgentHostApi);
  }
  useEffect(() => {
    if (!resolvedAgentHostApi) {
      return;
    }
    hostApiByOrigin.set(origin, resolvedAgentHostApi);
    return () => {
      if (hostApiByOrigin.get(origin) === resolvedAgentHostApi) {
        hostApiByOrigin.delete(origin);
      }
    };
  }, [origin, resolvedAgentHostApi]);
  return (
    <AgentActivityRuntimeProvider runtime={agentActivityRuntime}>
      <AgentActivityHostContext.Provider value={resolvedAgentHostApi}>
        {children}
      </AgentActivityHostContext.Provider>
    </AgentActivityRuntimeProvider>
  );
}

export function useAgentHostApi(): AgentHostRuntimeApi {
  const agentHostApi =
    useContext(AgentActivityHostContext) ?? getTestAgentHostApi();
  if (!agentHostApi) {
    throw new Error(
      "AgentActivityHostProvider is missing an agentHostApi instance."
    );
  }
  return agentHostApi;
}

export function useOptionalAgentHostApi(): AgentHostRuntimeApi | null {
  return useContext(AgentActivityHostContext) ?? getTestAgentHostApi();
}

export function getOptionalAgentHostApi(): AgentHostRuntimeApi | null {
  return (
    getExplicitWindowTestAgentHostApi() ??
    currentAgentHostApi ??
    getTestAgentHostApi()
  );
}

/**
 * Resolve the host API for a given runtime origin. When the origin is registered
 * (local vs shared/cloud host), returns that exact host API so its persistence
 * (read-state, etc.) targets the matching backend; otherwise falls back to
 * legacy single-host resolution.
 */
export function getAgentHostApiByOrigin(
  origin: string | null | undefined
): AgentHostRuntimeApi | null {
  const normalizedOrigin =
    origin?.trim() || WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN;
  const hostApi = hostApiByOrigin.get(normalizedOrigin);
  if (hostApi) {
    return hostApi;
  }
  // Only the default (local) origin falls back to the legacy single-host slot.
  // An explicit non-default origin that is not registered returns null so its
  // persistence never lands in a different host's store (e.g. shared read-state
  // must not be written to the local backend).
  if (normalizedOrigin === WORKSPACE_AGENT_ACTIVITY_RUNTIME_SESSION_ORIGIN) {
    return getOptionalAgentHostApi();
  }
  return null;
}

export function resetAgentHostApiForTests(): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentHostApi = null;
    hostApiByOrigin.clear();
  }
}

export function setAgentHostApiForTests(
  agentHostApi: AgentHostInputApi | AgentHostRuntimeApi | null
): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentHostApi = agentHostApi
      ? toAgentHostRuntimeApi(agentHostApi)
      : null;
  }
}

function getTestAgentHostApi(): AgentHostRuntimeApi | null {
  if (process.env.NODE_ENV !== "test") {
    return null;
  }
  if (typeof window === "undefined") {
    return null;
  }
  const explicitAgentHostApi = getExplicitWindowTestAgentHostApi();
  if (explicitAgentHostApi) {
    return explicitAgentHostApi;
  }
  if (currentAgentHostApi) {
    return currentAgentHostApi;
  }
  const testAgentHostApi = (
    window as unknown as Window & {
      agentHostApi?: AgentHostInputApi | AgentHostRuntimeApi;
    }
  ).agentHostApi;
  return testAgentHostApi ? toAgentHostRuntimeApi(testAgentHostApi) : null;
}

function getExplicitWindowTestAgentHostApi(): AgentHostRuntimeApi | null {
  if (process.env.NODE_ENV !== "test" || typeof window === "undefined") {
    return null;
  }
  const testDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "agentHostApi"
  );
  if (!testDescriptor || !("value" in testDescriptor)) {
    return null;
  }
  const testAgentHostApi = testDescriptor.value as
    | AgentHostInputApi
    | AgentHostRuntimeApi
    | undefined;
  return testAgentHostApi ? toAgentHostRuntimeApi(testAgentHostApi) : null;
}
