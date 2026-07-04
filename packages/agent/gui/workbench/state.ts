import type {
  WorkbenchHostExternalStateLookupInput,
  WorkbenchHostExternalStateSource
} from "@tutti-os/workbench-surface";
import {
  agentGuiWorkbenchProviders,
  isAgentGuiWorkbenchProvider,
  normalizeAgentGuiWorkbenchProvider
} from "./providerCatalog.ts";
import { agentGUIProviderTargetRefsEqual } from "../providerTargets.ts";
import type {
  AgentGuiWorkbenchComposerOverrides,
  AgentGuiWorkbenchComposerOverridesByAgentTargetId,
  AgentGuiWorkbenchComposerOverridesByProvider,
  AgentGuiWorkbenchNodeState,
  AgentGuiWorkbenchProvider,
  AgentGuiWorkbenchState,
  AgentGuiWorkbenchWorkspaceState
} from "./types.ts";
import type { AgentGUIProviderTargetRef } from "../types.ts";

type AgentGuiWorkbenchStateLookupRequest = Pick<
  WorkbenchHostExternalStateLookupInput,
  "instanceId" | "typeId"
> &
  Partial<Pick<WorkbenchHostExternalStateLookupInput, "nodeId">>;

export function createDefaultAgentGuiWorkbenchNodeState(
  provider: AgentGuiWorkbenchProvider = "codex"
): AgentGuiWorkbenchNodeState {
  return {
    agentTargetId: null,
    composerOverrides: null,
    composerOverridesByAgentTargetId: null,
    composerOverridesByProvider: null,
    conversationCount: null,
    conversationRailCollapsed: false,
    conversationRailWidthPx: null,
    lastActiveAgentSessionId: null,
    lastActiveConversationTitle: null,
    provider,
    providerTargetId: null,
    providerTargetRef: null
  };
}

export function normalizeAgentGuiWorkbenchState(
  state: unknown
): AgentGuiWorkbenchState {
  if (!isRecord(state)) {
    return createDefaultAgentGuiWorkbenchState();
  }
  const agentTargetId =
    normalizeOptionalNonEmptyString(state.agentTargetId) ??
    normalizeOptionalNonEmptyString(state.providerTargetId);
  return {
    ...(agentTargetId ? { agentTargetId } : {}),
    conversationRailCollapsed: state.conversationRailCollapsed === true,
    conversationRailWidthPx: normalizeOptionalPositiveNumber(
      state.conversationRailWidthPx
    ),
    lastActiveAgentSessionId:
      typeof state.lastActiveAgentSessionId === "string"
        ? state.lastActiveAgentSessionId
        : null
  };
}

export function projectAgentGuiWorkbenchState(
  state: AgentGuiWorkbenchNodeState
): AgentGuiWorkbenchState {
  const agentTargetId =
    normalizeOptionalNonEmptyString(state.agentTargetId) ??
    normalizeOptionalNonEmptyString(state.providerTargetId);
  return {
    ...(agentTargetId ? { agentTargetId } : {}),
    conversationRailCollapsed: state.conversationRailCollapsed === true,
    conversationRailWidthPx: normalizeOptionalPositiveNumber(
      state.conversationRailWidthPx
    ),
    lastActiveAgentSessionId: state.lastActiveAgentSessionId ?? null
  };
}

export function areAgentGuiWorkbenchStatesEqual(
  left: AgentGuiWorkbenchState,
  right: AgentGuiWorkbenchState
): boolean {
  return (
    (left.agentTargetId ?? null) === (right.agentTargetId ?? null) &&
    left.conversationRailCollapsed === right.conversationRailCollapsed &&
    left.conversationRailWidthPx === right.conversationRailWidthPx &&
    left.lastActiveAgentSessionId === right.lastActiveAgentSessionId
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
    agentTargetId:
      normalizeOptionalNonEmptyString(state?.agentTargetId) ??
      normalizeOptionalNonEmptyString(state?.providerTargetId),
    composerOverrides: normalizeAgentGuiWorkbenchComposerOverrides(
      state?.composerOverrides
    ),
    composerOverridesByAgentTargetId:
      normalizeAgentGuiWorkbenchComposerOverridesByAgentTargetId(
        state?.composerOverridesByAgentTargetId
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
    provider,
    providerTargetId: normalizeOptionalNonEmptyString(state?.providerTargetId),
    providerTargetRef: normalizeAgentGuiProviderTargetRef(
      state?.providerTargetRef,
      provider
    )
  };
}

export function areAgentGuiWorkbenchNodeStatesEqual(
  left: AgentGuiWorkbenchNodeState,
  right: AgentGuiWorkbenchNodeState
): boolean {
  return (
    (left.agentTargetId ?? null) === (right.agentTargetId ?? null) &&
    composerOverridesEqual(left.composerOverrides, right.composerOverrides) &&
    composerOverridesByAgentTargetIdEqual(
      left.composerOverridesByAgentTargetId,
      right.composerOverridesByAgentTargetId
    ) &&
    composerOverridesByProviderEqual(
      left.composerOverridesByProvider,
      right.composerOverridesByProvider
    ) &&
    left.conversationCount === right.conversationCount &&
    left.conversationRailCollapsed === right.conversationRailCollapsed &&
    left.conversationRailWidthPx === right.conversationRailWidthPx &&
    left.lastActiveAgentSessionId === right.lastActiveAgentSessionId &&
    left.lastActiveConversationTitle === right.lastActiveConversationTitle &&
    left.provider === right.provider &&
    (left.agentTargetId ?? null) === (right.agentTargetId ?? null) &&
    (left.providerTargetId ?? null) === (right.providerTargetId ?? null) &&
    agentGUIProviderTargetRefsEqual(
      left.providerTargetRef,
      right.providerTargetRef
    )
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
    request: AgentGuiWorkbenchStateLookupRequest
  ) => AgentGuiWorkbenchState | null;
  writeNodeState: (
    request: AgentGuiWorkbenchStateLookupRequest & {
      state: AgentGuiWorkbenchState;
    }
  ) => void;
  /**
   * Returns the launch instanceId of an open node currently showing the given
   * agent session, or null when none is found. Used to focus an existing
   * conversation instead of launching a duplicate node.
   */
  findInstanceIdByAgentSessionId: (agentSessionId: string) => string | null;
} {
  const typeId = input.typeId ?? "agent-gui";
  const nodeStateByKey = new Map<string, AgentGuiWorkbenchState>();
  // Tracks the launch instanceId behind each state key so a node can be located
  // by the session it is currently showing, even when its key is node-scoped.
  const instanceIdByKey = new Map<string, string>();
  const listeners = new Set<() => void>();

  const lookupState = (request: AgentGuiWorkbenchStateLookupRequest) => {
    const nodeState = request.nodeId
      ? nodeStateByKey.get(agentGuiWorkbenchNodeStateKey(request))
      : null;
    const state =
      nodeState ??
      nodeStateByKey.get(agentGuiWorkbenchInstanceStateKey(request));
    return state ? { ...state } : null;
  };

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
        return lookupState(request);
      },
      getSnapshotNodeState(request) {
        if (request.typeId !== typeId) {
          return null;
        }
        return lookupState(request);
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
      return lookupState(request);
    },
    findInstanceIdByAgentSessionId(agentSessionId) {
      const target = agentSessionId.trim();
      if (!target) {
        return null;
      }
      for (const [key, state] of nodeStateByKey) {
        if (state.lastActiveAgentSessionId?.trim() === target) {
          return instanceIdByKey.get(key) ?? null;
        }
      }
      return null;
    },
    writeNodeState(request) {
      if (request.typeId !== typeId) {
        return;
      }
      const key = agentGuiWorkbenchNodeStateKey(request);
      instanceIdByKey.set(key, request.instanceId);
      const previous = nodeStateByKey.get(key);
      let clearedInstanceSeed = false;
      if (request.nodeId) {
        const instanceKey = agentGuiWorkbenchInstanceStateKey(request);
        instanceIdByKey.delete(instanceKey);
        clearedInstanceSeed = nodeStateByKey.delete(instanceKey);
      }
      const next = {
        ...normalizeAgentGuiWorkbenchState(request.state)
      };
      nodeStateByKey.set(key, next);
      if (
        !clearedInstanceSeed &&
        previous &&
        areAgentGuiWorkbenchMemoryStatesEqual(previous, next)
      ) {
        return;
      }
      notify();
    }
  };
}

function areAgentGuiWorkbenchMemoryStatesEqual(
  left: AgentGuiWorkbenchState,
  right: AgentGuiWorkbenchState
): boolean {
  return areAgentGuiWorkbenchStatesEqual(left, right);
}

function agentGuiWorkbenchNodeStateKey(
  request: Pick<WorkbenchHostExternalStateLookupInput, "instanceId"> &
    Partial<Pick<WorkbenchHostExternalStateLookupInput, "nodeId">>
): string {
  return request.nodeId
    ? `node:${request.nodeId}`
    : agentGuiWorkbenchInstanceStateKey(request);
}

function agentGuiWorkbenchInstanceStateKey(
  request: Pick<WorkbenchHostExternalStateLookupInput, "instanceId">
): string {
  return `instance:${request.instanceId}`;
}

function createDefaultAgentGuiWorkbenchState(): AgentGuiWorkbenchState {
  return {
    conversationRailCollapsed: false,
    conversationRailWidthPx: null,
    lastActiveAgentSessionId: null
  };
}

function normalizeOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAgentGuiProviderTargetRef(
  value: unknown,
  expectedProvider?: AgentGuiWorkbenchProvider
): AgentGUIProviderTargetRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = normalizeOptionalNonEmptyString(value.kind);
  const provider = value.provider;
  if (!kind || !isAgentGuiWorkbenchProvider(provider)) {
    return null;
  }
  if (expectedProvider && provider !== expectedProvider) {
    return null;
  }
  return {
    ...value,
    kind,
    provider
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

function normalizeAgentGuiWorkbenchComposerOverridesByAgentTargetId(
  value: unknown
): AgentGuiWorkbenchComposerOverridesByAgentTargetId | null {
  if (!isRecord(value)) {
    return null;
  }
  const result: AgentGuiWorkbenchComposerOverridesByAgentTargetId = {};
  for (const [rawAgentTargetId, rawOverrides] of Object.entries(value)) {
    const agentTargetId = normalizeOptionalNonEmptyString(rawAgentTargetId);
    if (!agentTargetId) {
      continue;
    }
    const overrides = normalizeAgentGuiWorkbenchComposerOverrides(rawOverrides);
    if (overrides) {
      result[agentTargetId] = overrides;
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

function composerOverridesByAgentTargetIdEqual(
  left: AgentGuiWorkbenchComposerOverridesByAgentTargetId | null | undefined,
  right: AgentGuiWorkbenchComposerOverridesByAgentTargetId | null | undefined
): boolean {
  const leftKeys = Object.keys(left ?? {}).sort();
  const rightKeys = Object.keys(right ?? {}).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] &&
      composerOverridesEqual(left?.[key], right?.[key])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
