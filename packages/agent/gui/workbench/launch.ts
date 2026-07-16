import type { WorkbenchHostLaunchRequest } from "@tutti-os/workbench-surface";
import {
  isAgentGuiWorkbenchProvider,
  normalizeAgentGuiWorkbenchProvider
} from "./providerCatalog.ts";
import {
  agentGuiWorkbenchOpenSessionActivationType,
  agentGuiWorkbenchPrefillPromptActivationType,
  type AgentGuiWorkbenchPrefillPromptPayload,
  type AgentGuiWorkbenchProvider
} from "./types.ts";

export { agentGuiWorkbenchPrefillPromptActivationType } from "./types.ts";

type AgentGuiWorkbenchLaunchRequestInput = Pick<
  WorkbenchHostLaunchRequest,
  "launchSource" | "payload" | "typeId"
> & {
  dockEntryId?: string | null;
};

export const agentGuiWorkbenchTypeId = "agent-gui";

const agentGuiWorkbenchUnifiedDockEntryIdValue = "agent-gui:unified";
const agentGuiWorkbenchDockPopupNewWindowLaunchSource = "dock-popup-new-window";
let agentGuiWorkbenchInstanceSequence = 0;

export interface AgentGuiWorkbenchDockIdentity {
  kind: "unifiedAggregate";
}

/**
 * @deprecated AgentGUI has one canonical Dock entry. Use
 * {@link agentGuiWorkbenchUnifiedDockEntryId} instead.
 */
export function agentGuiWorkbenchDockEntryId(
  _provider: AgentGuiWorkbenchProvider
): string {
  return agentGuiWorkbenchUnifiedDockEntryId();
}

export function agentGuiWorkbenchUnifiedDockEntryId(): string {
  return agentGuiWorkbenchUnifiedDockEntryIdValue;
}

export function createAgentGuiWorkbenchInstanceId(): string {
  agentGuiWorkbenchInstanceSequence += 1;
  return `agent-gui:instance:${Date.now().toString(36)}-${agentGuiWorkbenchInstanceSequence.toString(36)}`;
}

export function agentGuiWorkbenchDockIdentityFromIdentifier(
  value: string | null | undefined
): AgentGuiWorkbenchDockIdentity | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (normalized === agentGuiWorkbenchUnifiedDockEntryId()) {
    return { kind: "unifiedAggregate" };
  }
  return null;
}

export function agentGuiWorkbenchProviderFromLaunchRequest(
  request: AgentGuiWorkbenchLaunchRequestInput
): AgentGuiWorkbenchProvider {
  const payloadProvider =
    request.payload &&
    typeof request.payload === "object" &&
    !Array.isArray(request.payload)
      ? (request.payload as { provider?: unknown }).provider
      : null;
  if (isAgentGuiWorkbenchProvider(payloadProvider)) {
    return payloadProvider;
  }
  throw new Error("agent_gui_workbench.launch_provider_required");
}

export function createAgentGuiWorkbenchSessionLaunchRequest(input: {
  agentTargetId?: string | null;
  agentSessionId?: string;
  openInNewWindow?: boolean;
  provider: unknown;
}) {
  const provider = normalizeAgentGuiWorkbenchProvider(input.provider);
  return {
    dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
    payload: {
      ...(input.agentTargetId?.trim()
        ? { agentTargetId: input.agentTargetId.trim() }
        : {}),
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      ...(input.openInNewWindow ? { openInNewWindow: true } : {}),
      provider
    },
    reason: "host" as const,
    typeId: agentGuiWorkbenchTypeId
  };
}

export function createAgentGuiWorkbenchDraftLaunchRequest(input: {
  agentTargetId?: string | null;
  autoSubmit?: boolean;
  draftPrompt: string;
  model?: string | null;
  modelPlanId?: string | null;
  openInNewWindow?: boolean;
  provider: unknown;
  userProjectPath?: string | null;
}) {
  const provider = normalizeAgentGuiWorkbenchProvider(input.provider);
  const userProjectPath = normalizeAgentGuiWorkbenchUserProjectPath(
    input.userProjectPath
  );
  return {
    dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
    payload: {
      draftPrompt: input.draftPrompt,
      provider,
      ...(input.agentTargetId?.trim()
        ? { agentTargetId: input.agentTargetId.trim() }
        : {}),
      ...(input.autoSubmit ? { autoSubmit: true } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.modelPlanId?.trim()
        ? { modelPlanId: input.modelPlanId.trim() }
        : {}),
      ...(input.openInNewWindow ? { openInNewWindow: true } : {}),
      ...(userProjectPath ? { userProjectPath } : {})
    },
    reason: "host" as const,
    typeId: agentGuiWorkbenchTypeId
  };
}

export interface AgentGuiWorkbenchLaunchDescriptor {
  activation:
    | {
        payload: {
          agentSessionId: string;
        };
        type: typeof agentGuiWorkbenchOpenSessionActivationType;
      }
    | {
        payload: AgentGuiWorkbenchPrefillPromptPayload;
        type: typeof agentGuiWorkbenchPrefillPromptActivationType;
      }
    | null;
  dockEntryId: string;
  instanceId: string;
  openInNewWindow: boolean;
  provider: AgentGuiWorkbenchProvider;
  reusePolicy: AgentGuiWorkbenchReusePolicy;
  targetAgentSessionId: string | null;
}

export type AgentGuiWorkbenchReusePolicy =
  | { kind: "dock-entry" }
  | { agentSessionId: string; kind: "current-session" }
  | { kind: "none" };

export function createAgentGuiWorkbenchLaunchDescriptor(
  request: AgentGuiWorkbenchLaunchRequestInput
): AgentGuiWorkbenchLaunchDescriptor {
  const provider = agentGuiWorkbenchProviderFromLaunchRequest(request);
  const dockEntryId = agentGuiWorkbenchUnifiedDockEntryId();
  const prefillPrompt = prefillPromptFromLaunchPayload(request.payload);
  if (prefillPrompt) {
    const openInNewWindow = openInNewWindowFromLaunchPayload(request.payload);
    return {
      activation: {
        payload: prefillPrompt,
        type: agentGuiWorkbenchPrefillPromptActivationType
      },
      dockEntryId,
      instanceId: createAgentGuiWorkbenchInstanceId(),
      openInNewWindow,
      provider,
      reusePolicy: { kind: "none" },
      targetAgentSessionId: null
    };
  }

  const targetAgentSessionId = agentSessionIdFromLaunchPayload(request.payload);
  const openInNewWindow = openInNewWindowFromLaunchRequest(request);
  const instanceId = createAgentGuiWorkbenchInstanceId();

  return {
    activation: targetAgentSessionId
      ? {
          payload: {
            agentSessionId: targetAgentSessionId
          },
          type: agentGuiWorkbenchOpenSessionActivationType
        }
      : null,
    dockEntryId,
    instanceId,
    openInNewWindow,
    provider,
    reusePolicy: openInNewWindow
      ? { kind: "none" }
      : targetAgentSessionId
        ? { agentSessionId: targetAgentSessionId, kind: "current-session" }
        : { kind: "dock-entry" },
    targetAgentSessionId
  };
}

/**
 * @deprecated AgentGUI launch results always use the unified Dock entry. Use
 * {@link agentGuiWorkbenchUnifiedDockEntryId} instead.
 */
export function resolveAgentGuiWorkbenchLaunchDockEntryId(_input: {
  provider: AgentGuiWorkbenchProvider;
  requestedDockEntryId?: string | null;
}): string {
  return agentGuiWorkbenchUnifiedDockEntryId();
}

function prefillPromptFromLaunchPayload(
  payload: unknown
): AgentGuiWorkbenchPrefillPromptPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const draftPrompt = (payload as { draftPrompt?: unknown }).draftPrompt;
  if (typeof draftPrompt !== "string" || !draftPrompt.trim()) {
    return null;
  }
  const autoSubmit = (payload as { autoSubmit?: unknown }).autoSubmit === true;
  const provider = (payload as { provider?: unknown }).provider;
  const model = (payload as { model?: unknown }).model;
  const modelPlanId = (payload as { modelPlanId?: unknown }).modelPlanId;
  const agentTargetId = agentTargetIdFromLaunchPayload(payload);
  const userProjectPath = (payload as { userProjectPath?: unknown })
    .userProjectPath;
  const normalizedUserProjectPath =
    typeof userProjectPath === "string"
      ? normalizeAgentGuiWorkbenchUserProjectPath(userProjectPath)
      : null;
  return {
    draftPrompt,
    ...(agentTargetId ? { agentTargetId } : {}),
    ...(autoSubmit ? { autoSubmit: true } : {}),
    ...(typeof model === "string" && model.trim()
      ? { model: model.trim() }
      : {}),
    ...(typeof modelPlanId === "string" && modelPlanId.trim()
      ? { modelPlanId: modelPlanId.trim() }
      : {}),
    ...(isAgentGuiWorkbenchProvider(provider) ? { provider } : {}),
    ...(normalizedUserProjectPath
      ? { userProjectPath: normalizedUserProjectPath }
      : {})
  };
}

function normalizeAgentGuiWorkbenchUserProjectPath(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized ? normalized : null;
}

function agentSessionIdFromLaunchPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const agentSessionId = (payload as { agentSessionId?: unknown })
    .agentSessionId;
  return typeof agentSessionId === "string" && agentSessionId.trim()
    ? agentSessionId.trim()
    : null;
}

function agentTargetIdFromLaunchPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const agentTargetId = (payload as { agentTargetId?: unknown }).agentTargetId;
  return typeof agentTargetId === "string" && agentTargetId.trim()
    ? agentTargetId.trim()
    : null;
}

function openInNewWindowFromLaunchPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  return (payload as { openInNewWindow?: unknown }).openInNewWindow === true;
}

function openInNewWindowFromLaunchRequest(
  request: AgentGuiWorkbenchLaunchRequestInput
): boolean {
  return (
    openInNewWindowFromLaunchPayload(request.payload) ||
    request.launchSource === agentGuiWorkbenchDockPopupNewWindowLaunchSource
  );
}
