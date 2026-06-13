import {
  createContext,
  useContext,
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

const AgentActivityHostContext = createContext<AgentHostRuntimeApi | null>(
  null
);

let currentAgentHostApi: AgentHostRuntimeApi | null = null;

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

export function getAgentHostApi(): AgentHostRuntimeApi {
  const agentHostApi =
    getExplicitWindowTestAgentHostApi() ??
    currentAgentHostApi ??
    getTestAgentHostApi();
  if (!agentHostApi) {
    throw new Error(
      "AgentActivityHostProvider is missing an agentHostApi instance."
    );
  }
  return agentHostApi;
}

export function getOptionalAgentHostApi(): AgentHostRuntimeApi | null {
  return (
    getExplicitWindowTestAgentHostApi() ??
    currentAgentHostApi ??
    getTestAgentHostApi()
  );
}

export function resetAgentHostApiForTests(): void {
  if (process.env.NODE_ENV === "test") {
    currentAgentHostApi = null;
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
