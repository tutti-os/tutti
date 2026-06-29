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
let agentGuiWorkbenchInstanceSequence = 0;

export function agentGuiWorkbenchDockEntryId(
  provider: AgentGuiWorkbenchProvider
): string {
  return provider === "codex"
    ? agentGuiWorkbenchTypeId
    : `${agentGuiWorkbenchDockEntryPrefix}${provider}`;
}

export function agentGuiWorkbenchInstanceId(
  provider: AgentGuiWorkbenchProvider
): string {
  return `${agentGuiWorkbenchDockEntryPrefix}${provider}`;
}

export function createAgentGuiWorkbenchInstanceId(input: {
  agentSessionId?: string | null;
  provider: AgentGuiWorkbenchProvider;
}): string {
  const prefix = agentGuiWorkbenchInstanceId(input.provider);
  const agentSessionId = input.agentSessionId?.trim();
  if (agentSessionId) {
    return `${prefix}:session:${encodeAgentGuiWorkbenchInstanceSegment(
      agentSessionId
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
  const normalized = value?.trim();
  if (!normalized || normalized === agentGuiWorkbenchTypeId) {
    return normalized === agentGuiWorkbenchTypeId ? "codex" : null;
  }
  if (!normalized.startsWith(agentGuiWorkbenchDockEntryPrefix)) {
    return null;
  }
  const provider = normalized
    .slice(agentGuiWorkbenchDockEntryPrefix.length)
    .split(":", 1)[0];
  return isAgentGuiWorkbenchProvider(provider) ? provider : null;
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
  provider: unknown;
}) {
  const provider = normalizeAgentGuiWorkbenchProvider(input.provider);
  return {
    dockEntryId: agentGuiWorkbenchDockEntryId(provider),
    payload: {
      ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
      provider
    },
    reason: "host" as const,
    typeId: agentGuiWorkbenchTypeId
  };
}

export function createAgentGuiWorkbenchDraftLaunchRequest(input: {
  agentSessionId?: string | null;
  autoSubmit?: boolean;
  draftPrompt: string;
  provider: unknown;
  userProjectPath?: string | null;
}) {
  const provider = normalizeAgentGuiWorkbenchProvider(input.provider);
  const agentSessionId = input.agentSessionId?.trim();
  const userProjectPath = normalizeAgentGuiWorkbenchUserProjectPath(
    input.userProjectPath
  );
  return {
    dockEntryId: agentGuiWorkbenchDockEntryId(provider),
    payload: {
      draftPrompt: input.draftPrompt,
      provider,
      ...(agentSessionId ? { agentSessionId } : {}),
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
  provider: AgentGuiWorkbenchProvider;
  reuseDockEntryNode: boolean;
  targetAgentSessionId: string | null;
}

export function createAgentGuiWorkbenchLaunchDescriptor(
  request: AgentGuiWorkbenchLaunchRequestInput
): AgentGuiWorkbenchLaunchDescriptor {
  const provider = agentGuiWorkbenchProviderFromLaunchRequest(request);
  const prefillPrompt = prefillPromptFromLaunchPayload(request.payload);
  if (prefillPrompt) {
    return {
      activation: {
        payload: prefillPrompt,
        type: agentGuiWorkbenchPrefillPromptActivationType
      },
      dockEntryId:
        request.dockEntryId ?? agentGuiWorkbenchDockEntryId(provider),
      instanceId: createAgentGuiWorkbenchInstanceId({ provider }),
      provider,
      reuseDockEntryNode: true,
      targetAgentSessionId: null
    };
  }

  const targetAgentSessionId = agentSessionIdFromLaunchPayload(request.payload);
  const instanceId = createAgentGuiWorkbenchInstanceId({
    agentSessionId: targetAgentSessionId,
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
    dockEntryId: request.dockEntryId ?? agentGuiWorkbenchDockEntryId(provider),
    instanceId,
    provider,
    reuseDockEntryNode: false,
    targetAgentSessionId
  };
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
  const agentSessionId = agentSessionIdFromLaunchPayload(payload);
  const userProjectPath = (payload as { userProjectPath?: unknown })
    .userProjectPath;
  const normalizedUserProjectPath =
    typeof userProjectPath === "string"
      ? normalizeAgentGuiWorkbenchUserProjectPath(userProjectPath)
      : null;
  return {
    draftPrompt,
    ...(agentSessionId ? { agentSessionId } : {}),
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
