import type {
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource
} from "@tutti-os/workbench-surface";
import {
  agentGuiWorkbenchProviders,
  normalizeAgentGuiWorkbenchProvider
} from "./providerCatalog.ts";
import type {
  AgentGuiWorkbenchComposerOverrides,
  AgentGuiWorkbenchComposerOverridesByProvider,
  AgentGuiWorkbenchNodeState,
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState,
  AgentGuiWorkbenchWorkspaceState
} from "./types.ts";

export function createDefaultAgentGuiWorkbenchNodeState(
  provider: AgentGuiWorkbenchProvider = "codex"
): AgentGuiWorkbenchNodeState {
  return {
    composerOverrides: null,
    composerOverridesByProvider: null,
    conversationCount: null,
    conversationRailCollapsed: false,
    conversationRailWidthPx: null,
    lastActiveAgentSessionId: null,
    lastActiveConversationTitle: null,
    provider
  };
}

export function normalizeAgentGuiWorkbenchState(
  state: unknown
): AgentGuiWorkbenchState {
  if (!isRecord(state)) {
    return createDefaultAgentGuiWorkbenchState();
  }
  return {
    composerOverrides: normalizeAgentGuiWorkbenchComposerOverrides(
      state.composerOverrides
    ),
    composerOverridesByProvider:
      normalizeAgentGuiWorkbenchComposerOverridesByProvider(
        state.composerOverridesByProvider
      ),
    conversationRailCollapsed: state.conversationRailCollapsed === true,
    conversationRailWidthPx: normalizeOptionalPositiveNumber(
      state.conversationRailWidthPx
    ),
    lastActiveAgentSessionId:
      typeof state.lastActiveAgentSessionId === "string"
        ? state.lastActiveAgentSessionId
        : null,
    lastActiveConversationTitle:
      typeof state.lastActiveConversationTitle === "string"
        ? state.lastActiveConversationTitle
        : null
  };
}

export function projectAgentGuiWorkbenchState(
  state: AgentGuiWorkbenchNodeState
): AgentGuiWorkbenchState {
  return {
    composerOverrides: normalizeAgentGuiWorkbenchComposerOverrides(
      state.composerOverrides
    ),
    composerOverridesByProvider:
      normalizeAgentGuiWorkbenchComposerOverridesByProvider(
        state.composerOverridesByProvider
      ),
    conversationRailCollapsed: state.conversationRailCollapsed === true,
    conversationRailWidthPx: normalizeOptionalPositiveNumber(
      state.conversationRailWidthPx
    ),
    lastActiveAgentSessionId: state.lastActiveAgentSessionId ?? null,
    lastActiveConversationTitle: state.lastActiveConversationTitle ?? null
  };
}

export function areAgentGuiWorkbenchStatesEqual(
  left: AgentGuiWorkbenchState,
  right: AgentGuiWorkbenchState
): boolean {
  return (
    composerOverridesEqual(left.composerOverrides, right.composerOverrides) &&
    composerOverridesByProviderEqual(
      left.composerOverridesByProvider,
      right.composerOverridesByProvider
    ) &&
    left.conversationRailCollapsed === right.conversationRailCollapsed &&
    left.conversationRailWidthPx === right.conversationRailWidthPx &&
    left.lastActiveAgentSessionId === right.lastActiveAgentSessionId &&
    left.lastActiveConversationTitle === right.lastActiveConversationTitle
  );
}

export function normalizeAgentGuiWorkbenchNodeState(
  state: Partial<AgentGuiWorkbenchNodeState> | null | undefined,
  fallbackProvider: AgentGuiWorkbenchProvider = "codex"
): AgentGuiWorkbenchNodeState {
  const provider = normalizeAgentGuiWorkbenchProvider(
    state?.provider,
    fallbackProvider
  );
  return {
    ...createDefaultAgentGuiWorkbenchNodeState(provider),
    composerOverrides: normalizeAgentGuiWorkbenchComposerOverrides(
      state?.composerOverrides
    ),
    composerOverridesByProvider:
      normalizeAgentGuiWorkbenchComposerOverridesByProvider(
        state?.composerOverridesByProvider
      ),
    conversationCount: normalizeOptionalNonNegativeNumber(
      state?.conversationCount
    ),
    conversationRailCollapsed: state?.conversationRailCollapsed === true,
    conversationRailWidthPx: normalizeOptionalPositiveNumber(
      state?.conversationRailWidthPx
    ),
    lastActiveAgentSessionId:
      typeof state?.lastActiveAgentSessionId === "string"
        ? state.lastActiveAgentSessionId
        : null,
    lastActiveConversationTitle:
      typeof state?.lastActiveConversationTitle === "string"
        ? state.lastActiveConversationTitle
        : null,
    provider
  };
}

export function areAgentGuiWorkbenchNodeStatesEqual(
  left: AgentGuiWorkbenchNodeState,
  right: AgentGuiWorkbenchNodeState
): boolean {
  return (
    composerOverridesEqual(left.composerOverrides, right.composerOverrides) &&
    composerOverridesByProviderEqual(
      left.composerOverridesByProvider,
      right.composerOverridesByProvider
    ) &&
    left.conversationCount === right.conversationCount &&
    left.conversationRailCollapsed === right.conversationRailCollapsed &&
    left.conversationRailWidthPx === right.conversationRailWidthPx &&
    left.lastActiveAgentSessionId === right.lastActiveAgentSessionId &&
    left.lastActiveConversationTitle === right.lastActiveConversationTitle &&
    left.provider === right.provider
  );
}

export function agentGuiWorkbenchProviderFromInstanceId(
  instanceId: string | null | undefined
): AgentGuiWorkbenchProvider {
  const normalized = instanceId?.trim();
  if (!normalized || normalized === "agent-gui") {
    return "codex";
  }
  const [, provider] = normalized.split(":", 3);
  return normalizeAgentGuiWorkbenchProvider(provider);
}

export function createAgentGuiWorkbenchNodeStateSource(input: {
  typeId?: string;
  workspaceId: string;
}): {
  externalStateSource: WorkbenchHostExternalStateSource<
    AgentGuiWorkbenchState | null,
    AgentGuiWorkbenchWorkspaceState
  >;
  readNodeState: (
    request: Pick<
      WorkbenchHostExternalStateLookupInput,
      "instanceId" | "typeId"
    >
  ) => AgentGuiWorkbenchState | null;
  writeNodeState: (
    request: Pick<
      WorkbenchHostExternalStateLookupInput,
      "instanceId" | "typeId"
    > & { state: AgentGuiWorkbenchState }
  ) => void;
} {
  const typeId = input.typeId ?? "agent-gui";
  const nodeStateByInstanceId = new Map<string, AgentGuiWorkbenchState>();
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    externalStateSource: {
      getNodeState(request) {
        if (request.typeId !== typeId) {
          return null;
        }
        const state = nodeStateByInstanceId.get(request.instanceId);
        return state ? { ...state } : null;
      },
      getSnapshotNodeState(request) {
        if (request.typeId !== typeId) {
          return null;
        }
        const state = nodeStateByInstanceId.get(request.instanceId);
        return state ? { ...state } : null;
      },
      getWorkspaceState() {
        return {
          workspaceId: input.workspaceId
        };
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    },
    readNodeState(request) {
      if (request.typeId !== typeId) {
        return null;
      }
      const state = nodeStateByInstanceId.get(request.instanceId);
      return state ? { ...state } : null;
    },
    writeNodeState(request) {
      if (request.typeId !== typeId) {
        return;
      }
      nodeStateByInstanceId.set(request.instanceId, {
        ...normalizeAgentGuiWorkbenchState(request.state)
      });
      notify();
    }
  };
}

function createDefaultAgentGuiWorkbenchState(): AgentGuiWorkbenchState {
  return {
    composerOverrides: null,
    composerOverridesByProvider: null,
    conversationRailCollapsed: false,
    conversationRailWidthPx: null,
    lastActiveAgentSessionId: null,
    lastActiveConversationTitle: null
  };
}

function normalizeAgentGuiWorkbenchComposerOverrides(
  value: unknown
): AgentGuiWorkbenchComposerOverrides | null {
  if (!isRecord(value)) {
    return null;
  }
  const composerOverrides: AgentGuiWorkbenchComposerOverrides = {};
  if (typeof value.model === "string" && value.model.trim()) {
    composerOverrides.model = value.model.trim();
  }
  if (
    typeof value.reasoningEffort === "string" &&
    value.reasoningEffort.trim()
  ) {
    composerOverrides.reasoningEffort = value.reasoningEffort.trim();
  }
  if (
    typeof value.permissionModeId === "string" &&
    value.permissionModeId.trim()
  ) {
    composerOverrides.permissionModeId = value.permissionModeId.trim();
  }
  if (typeof value.planMode === "boolean") {
    composerOverrides.planMode = value.planMode;
  }
  return Object.keys(composerOverrides).length > 0 ? composerOverrides : null;
}

function normalizeAgentGuiWorkbenchComposerOverridesByProvider(
  value: unknown
): AgentGuiWorkbenchComposerOverridesByProvider | null {
  if (!isRecord(value)) {
    return null;
  }
  const result: AgentGuiWorkbenchComposerOverridesByProvider = {};
  for (const provider of agentGuiWorkbenchProviders) {
    const overrides = normalizeAgentGuiWorkbenchComposerOverrides(
      value[provider]
    );
    if (overrides) {
      result[provider] = overrides;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function normalizeOptionalPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function normalizeOptionalNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function composerOverridesEqual(
  left: AgentGuiWorkbenchComposerOverrides | null | undefined,
  right: AgentGuiWorkbenchComposerOverrides | null | undefined
): boolean {
  return (
    (left?.model ?? null) === (right?.model ?? null) &&
    (left?.permissionModeId ?? null) === (right?.permissionModeId ?? null) &&
    (left?.planMode ?? null) === (right?.planMode ?? null) &&
    (left?.reasoningEffort ?? null) === (right?.reasoningEffort ?? null)
  );
}

function composerOverridesByProviderEqual(
  left: AgentGuiWorkbenchComposerOverridesByProvider | null | undefined,
  right: AgentGuiWorkbenchComposerOverridesByProvider | null | undefined
): boolean {
  for (const provider of agentGuiWorkbenchProviders) {
    if (!composerOverridesEqual(left?.[provider], right?.[provider])) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
