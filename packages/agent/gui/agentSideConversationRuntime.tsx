import { createContext, useContext, type PropsWithChildren } from "react";
import {
  useEngineSelector,
  type EngineStateStore
} from "./shared/engine/useEngineSelector";
import type { AgentPromptContentBlock } from "./shared/contracts/dto/agentSession";
import type { AgentActivityEphemeralConversationProjection } from "@tutti-os/agent-activity-core";

export interface AgentSideCapabilities {
  supported: boolean;
  /** Provider can snapshot a source while its Turn is active. */
  activeSourceTurn: boolean;
  ephemeral: boolean;
  hideInheritedTurns: boolean;
  modelBoundaryInjected: boolean;
}

export function supportsAgentSideConversation(
  capabilities: AgentSideCapabilities
): boolean {
  return (
    capabilities.supported &&
    capabilities.activeSourceTurn &&
    capabilities.ephemeral &&
    capabilities.hideInheritedTurns &&
    capabilities.modelBoundaryInjected
  );
}

export interface AgentSideInteractionAction {
  id: string;
  label: string;
  semantic: string;
}

export interface AgentSideInteraction {
  requestId: string;
  turnId: string;
  kind: "approval" | "plan" | "question";
  toolName: string | null;
  input: Record<string, unknown>;
  actions: readonly AgentSideInteractionAction[];
}

export interface AgentSideConversationState {
  workspaceId: string;
  sourceAgentSessionId: string;
  sideAgentSessionId: string;
  status: "idle" | "opening" | "running" | "closing" | "expired" | "error";
  activeTurnId: string | null;
  projection: AgentActivityEphemeralConversationProjection;
  pendingInteraction: AgentSideInteraction | null;
  error: string | null;
  sequence: number;
}

export interface AgentSideConversationSnapshot {
  workspaceId: string;
  active: AgentSideConversationState | null;
}

export interface AgentSideConversationOpenInput {
  workspaceId: string;
  sourceAgentSessionId: string;
  provider?: string | null;
  cwd?: string | null;
}

export interface AgentSideConversationSendInput {
  workspaceId: string;
  sideAgentSessionId: string;
  content: readonly AgentPromptContentBlock[];
  displayPrompt?: string;
}

export interface AgentSideConversationRuntime {
  resolveCapabilities(
    input: AgentSideConversationOpenInput
  ): Promise<AgentSideCapabilities>;
  open(
    input: AgentSideConversationOpenInput
  ): Promise<AgentSideConversationState>;
  send(input: AgentSideConversationSendInput): Promise<void>;
  cancel(input: {
    workspaceId: string;
    sideAgentSessionId: string;
    turnId: string;
  }): Promise<void>;
  respond(input: {
    workspaceId: string;
    sideAgentSessionId: string;
    turnId: string;
    requestId: string;
    action?: string;
    optionId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
  close(input: {
    workspaceId: string;
    sideAgentSessionId: string;
  }): Promise<void>;
  getSnapshot(workspaceId: string): AgentSideConversationSnapshot;
  subscribe(workspaceId: string, listener: () => void): () => void;
  subscribeConnectionState(
    listener: (
      state: "connected" | "connecting" | "disconnected" | "disposed"
    ) => void
  ): () => void;
  dispose?(): void;
}

const AgentSideConversationRuntimeContext =
  createContext<AgentSideConversationRuntime | null>(null);

export function AgentSideConversationRuntimeProvider({
  children,
  runtime
}: PropsWithChildren<{
  runtime?: AgentSideConversationRuntime | null;
}>): React.JSX.Element {
  return (
    <AgentSideConversationRuntimeContext.Provider value={runtime ?? null}>
      {children}
    </AgentSideConversationRuntimeContext.Provider>
  );
}

export function useOptionalAgentSideConversationRuntime(): AgentSideConversationRuntime | null {
  return useContext(AgentSideConversationRuntimeContext);
}

const EMPTY_SNAPSHOTS = new Map<string, AgentSideConversationSnapshot>();
const EMPTY_STORES = new Map<
  string,
  EngineStateStore<AgentSideConversationSnapshot>
>();
const RUNTIME_STORES = new WeakMap<
  AgentSideConversationRuntime,
  Map<string, EngineStateStore<AgentSideConversationSnapshot>>
>();
interface AgentSideCapabilitySnapshot {
  supported: boolean;
  settled: boolean;
}

const EMPTY_CAPABILITY_SNAPSHOT: AgentSideCapabilitySnapshot = {
  supported: false,
  settled: true
};
const EMPTY_CAPABILITY_STORE: EngineStateStore<AgentSideCapabilitySnapshot> = {
  getSnapshot: () => EMPTY_CAPABILITY_SNAPSHOT,
  subscribe: () => () => {}
};
const RUNTIME_CAPABILITY_STORES = new WeakMap<
  AgentSideConversationRuntime,
  Map<
    string,
    EngineStateStore<AgentSideCapabilitySnapshot> & {
      revision: string;
    }
  >
>();

function emptySnapshot(workspaceId: string): AgentSideConversationSnapshot {
  let snapshot = EMPTY_SNAPSHOTS.get(workspaceId);
  if (!snapshot) {
    snapshot = { workspaceId, active: null };
    EMPTY_SNAPSHOTS.set(workspaceId, snapshot);
  }
  return snapshot;
}

function sideConversationStore(
  runtime: AgentSideConversationRuntime | null,
  workspaceId: string
): EngineStateStore<AgentSideConversationSnapshot> {
  if (!runtime) {
    let store = EMPTY_STORES.get(workspaceId);
    if (!store) {
      const snapshot = emptySnapshot(workspaceId);
      store = {
        getSnapshot: () => snapshot,
        subscribe: () => () => {}
      };
      EMPTY_STORES.set(workspaceId, store);
    }
    return store;
  }
  let stores = RUNTIME_STORES.get(runtime);
  if (!stores) {
    stores = new Map();
    RUNTIME_STORES.set(runtime, stores);
  }
  let store = stores.get(workspaceId);
  if (!store) {
    store = {
      getSnapshot: () => runtime.getSnapshot(workspaceId),
      subscribe: (listener) => runtime.subscribe(workspaceId, listener)
    };
    stores.set(workspaceId, store);
  }
  return store;
}

export function useAgentSideConversationSnapshot(
  workspaceId: string
): AgentSideConversationSnapshot {
  const runtime = useOptionalAgentSideConversationRuntime();
  const normalizedWorkspaceId = workspaceId.trim();
  return useEngineSelector(
    sideConversationStore(runtime, normalizedWorkspaceId),
    (snapshot) => snapshot
  );
}

function sideCapabilityStore(
  runtime: AgentSideConversationRuntime | null,
  input: AgentSideConversationOpenInput,
  revision: string
): EngineStateStore<AgentSideCapabilitySnapshot> {
  if (!runtime || !input.sourceAgentSessionId) return EMPTY_CAPABILITY_STORE;
  const capabilityRuntime = runtime;
  let stores = RUNTIME_CAPABILITY_STORES.get(runtime);
  if (!stores) {
    stores = new Map();
    RUNTIME_CAPABILITY_STORES.set(runtime, stores);
  }
  const key = JSON.stringify(input);
  const existing = stores.get(key);
  if (existing?.revision === revision) return existing;
  let snapshot: AgentSideCapabilitySnapshot = {
    supported: false,
    settled: false
  };
  const listeners = new Set<() => void>();
  let connectionUnsubscribe: (() => void) | null = null;
  let pendingReprobe = false;
  let probing = false;
  const notify = () => listeners.forEach((listener) => listener());
  async function probe(): Promise<void> {
    if (probing) return;
    probing = true;
    try {
      const capabilities = await capabilityRuntime.resolveCapabilities(input);
      snapshot = {
        supported: supportsAgentSideConversation(capabilities),
        settled: true
      };
    } catch {
      snapshot = EMPTY_CAPABILITY_SNAPSHOT;
    } finally {
      probing = false;
      notify();
      if (pendingReprobe) {
        pendingReprobe = false;
        if (listeners.size > 0 && !snapshot.supported) void probe();
      }
    }
  }
  const store: EngineStateStore<AgentSideCapabilitySnapshot> & {
    revision: string;
  } = {
    revision,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (!connectionUnsubscribe) {
        connectionUnsubscribe = capabilityRuntime.subscribeConnectionState(
          (state) => {
            if (state !== "connected") return;
            if (probing || !snapshot.settled) {
              pendingReprobe = true;
              return;
            }
            if (!snapshot.supported) void probe();
          }
        );
      }
      if (snapshot.settled && !snapshot.supported) void probe();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          connectionUnsubscribe?.();
          connectionUnsubscribe = null;
        }
      };
    }
  };
  stores.set(key, store);
  void probe();
  return store;
}

export function useAgentSideConversationSupport(
  input: AgentSideConversationOpenInput,
  revision = ""
): boolean {
  const runtime = useOptionalAgentSideConversationRuntime();
  return useEngineSelector(
    sideCapabilityStore(runtime, input, revision),
    (snapshot) => (snapshot.settled ? snapshot.supported : false)
  );
}
