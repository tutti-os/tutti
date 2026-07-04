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
  "payload" | "typeId"
> & {
  dockEntryId?: string | null;
};

export const agentGuiWorkbenchTypeId = "agent-gui";

const agentGuiWorkbenchDockEntryPrefix = "agent-gui:";
const agentGuiWorkbenchUnifiedDockEntryIdValue = "agent-gui:unified";
let agentGuiWorkbenchInstanceSequence = 0;

export type AgentGuiWorkbenchDockLayout = "legacySplit" | "unified";

export type AgentGuiWorkbenchDockIdentity =
  | {
      kind: "legacyProvider";
      provider: AgentGuiWorkbenchProvider;
    }
  | {
      kind: "unifiedAggregate";
    };

export function agentGuiWorkbenchDockEntryId(
  provider: AgentGuiWorkbenchProvider
): string {
  return provider === "codex"
    ? agentGuiWorkbenchTypeId
    : `${agentGuiWorkbenchDockEntryPrefix}${provider}`;
}

export function agentGuiWorkbenchUnifiedDockEntryId(): string {
  return agentGuiWorkbenchUnifiedDockEntryIdValue;
}

export function agentGuiWorkbenchDockEntryIdForLayout(input: {
  dockLayout: AgentGuiWorkbenchDockLayout;
  provider: AgentGuiWorkbenchProvider;
}): string {
  return input.dockLayout === "unified"
    ? agentGuiWorkbenchUnifiedDockEntryId()
    : agentGuiWorkbenchDockEntryId(input.provider);
}

export function agentGuiWorkbenchInstanceId(
  provider: AgentGuiWorkbenchProvider
): string {
  return `${agentGuiWorkbenchDockEntryPrefix}${provider}`;
}

export function createAgentGuiWorkbenchInstanceId(input: {
  agentSessionId?: string | null;
  agentTargetId?: string | null;
  provider: AgentGuiWorkbenchProvider;
}): string {
  const prefix = agentGuiWorkbenchInstanceId(input.provider);
  const agentSessionId = input.agentSessionId?.trim();
  if (agentSessionId) {
    return `${prefix}:session:${encodeAgentGuiWorkbenchInstanceSegment(
      agentSessionId
    )}`;
  }
  const agentTargetId = input.agentTargetId?.trim();
  if (agentTargetId) {
    return `${prefix}:target:${encodeAgentGuiWorkbenchInstanceSegment(
      agentTargetId
    )}`;
  }

  agentGuiWorkbenchInstanceSequence += 1;
  return [
    prefix,
    "panel",
    `${Date.now().toString(36)}-${agentGuiWorkbenchInstanceSequence.toString(36)}`
  ].join(":");
}

export function agentGuiWorkbenchProviderFromIdentifier(
  value: string | null | undefined
): AgentGuiWorkbenchProvider | null {
  const identity = agentGuiWorkbenchDockIdentityFromIdentifier(value);
  return identity?.kind === "legacyProvider" ? identity.provider : null;
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
  if (normalized === agentGuiWorkbenchTypeId) {
    return { kind: "legacyProvider", provider: "codex" };
  }
  if (!normalized.startsWith(agentGuiWorkbenchDockEntryPrefix)) {
    return null;
  }
  const provider = normalized
    .slice(agentGuiWorkbenchDockEntryPrefix.length)
    .split(":", 1)[0];
  return isAgentGuiWorkbenchProvider(provider)
    ? { kind: "legacyProvider", provider }
    : null;
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
  return (
    agentGuiWorkbenchProviderFromIdentifier(request.dockEntryId) ??
    agentGuiWorkbenchProviderFromIdentifier(request.typeId) ??
    "codex"
  );
}

export function createAgentGuiWorkbenchSessionLaunchRequest(input: {
  agentSessionId?: string;
  openInNewWindow?: boolean;
  provider: unknown;
}) {
  const provider = normalizeAgentGuiWorkbenchProvider(input.provider);
  return {
    dockEntryId: agentGuiWorkbenchDockEntryId(provider),
    payload: {
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      ...(input.openInNewWindow ? { openInNewWindow: true } : {}),
      provider
    },
    reason: "host" as const,
    typeId: agentGuiWorkbenchTypeId
  };
}

export function createAgentGuiWorkbenchDraftLaunchRequest(input: {
  autoSubmit?: boolean;
  draftPrompt: string;
  provider: unknown;
  userProjectPath?: string | null;
}) {
  const provider = normalizeAgentGuiWorkbenchProvider(input.provider);
  const userProjectPath = normalizeAgentGuiWorkbenchUserProjectPath(
    input.userProjectPath
  );
  return {
    dockEntryId: agentGuiWorkbenchDockEntryId(provider),
    payload: {
      draftPrompt: input.draftPrompt,
      provider,
      ...(input.autoSubmit ? { autoSubmit: true } : {}),
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
  reuseDockEntryNode: boolean;
  reuseExistingSessionNode: boolean;
  targetAgentSessionId: string | null;
}

export function createAgentGuiWorkbenchLaunchDescriptor(
  request: AgentGuiWorkbenchLaunchRequestInput
): AgentGuiWorkbenchLaunchDescriptor {
  const provider = agentGuiWorkbenchProviderFromLaunchRequest(request);
  const dockEntryId = resolveAgentGuiWorkbenchLaunchDockEntryId({
    provider,
    requestedDockEntryId: request.dockEntryId
  });
  const prefillPrompt = prefillPromptFromLaunchPayload(request.payload);
  if (prefillPrompt) {
    return {
      activation: {
        payload: prefillPrompt,
        type: agentGuiWorkbenchPrefillPromptActivationType
      },
      dockEntryId,
      instanceId: createAgentGuiWorkbenchInstanceId({
        agentTargetId: agentTargetIdFromLaunchPayload(request.payload),
        provider
      }),
      openInNewWindow: false,
      provider,
      reuseDockEntryNode: shouldReuseAgentGuiWorkbenchDockEntryNode({
        dockEntryId,
        launchKind: "prefill"
      }),
      reuseExistingSessionNode: true,
      targetAgentSessionId: null
    };
  }

  const targetAgentSessionId = agentSessionIdFromLaunchPayload(request.payload);
  const openInNewWindow = openInNewWindowFromLaunchPayload(request.payload);
  const instanceId = createAgentGuiWorkbenchInstanceId({
    agentSessionId: openInNewWindow ? null : targetAgentSessionId,
    agentTargetId: openInNewWindow
      ? null
      : agentTargetIdFromLaunchPayload(request.payload),
    provider
  });

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
    reuseDockEntryNode: shouldReuseAgentGuiWorkbenchDockEntryNode({
      dockEntryId,
      launchKind: targetAgentSessionId ? "session" : "empty"
    }),
    reuseExistingSessionNode: !openInNewWindow,
    targetAgentSessionId
  };
}

export function resolveAgentGuiWorkbenchLaunchDockEntryId(input: {
  provider: AgentGuiWorkbenchProvider;
  requestedDockEntryId?: string | null;
}): string {
  const requestedIdentity = agentGuiWorkbenchDockIdentityFromIdentifier(
    input.requestedDockEntryId
  );
  if (requestedIdentity?.kind === "unifiedAggregate") {
    return agentGuiWorkbenchUnifiedDockEntryId();
  }
  return agentGuiWorkbenchDockEntryId(input.provider);
}

export function shouldReuseAgentGuiWorkbenchDockEntryNode(input: {
  dockEntryId: string;
  launchKind: "empty" | "prefill" | "session";
}): boolean {
  if (input.launchKind !== "prefill") {
    return false;
  }
  return (
    agentGuiWorkbenchDockIdentityFromIdentifier(input.dockEntryId)?.kind !==
    "unifiedAggregate"
  );
}

function encodeAgentGuiWorkbenchInstanceSegment(value: string): string {
  return encodeURIComponent(value.trim());
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
  const userProjectPath = (payload as { userProjectPath?: unknown })
    .userProjectPath;
  const normalizedUserProjectPath =
    typeof userProjectPath === "string"
      ? normalizeAgentGuiWorkbenchUserProjectPath(userProjectPath)
      : null;
  return {
    draftPrompt,
    ...(autoSubmit ? { autoSubmit: true } : {}),
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
