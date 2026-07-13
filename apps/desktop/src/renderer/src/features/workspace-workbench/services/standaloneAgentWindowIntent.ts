import type {
  AgentProviderAction,
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentGUIAgent,
  AgentGUIAgentAvailability,
  AgentGUIProvider
} from "@tutti-os/agent-gui";
import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import type { DesktopWindowIntent } from "../../../../../shared/contracts/windowIntent.ts";
import {
  desktopAgentGUIOpenSessionActivationType,
  desktopAgentGUIPrefillPromptActivationType,
  type DesktopAgentGUIProvider
} from "../../workspace-agent/desktopAgentGUINodeState.ts";
import type { AgentProviderStatusSnapshot } from "../../workspace-agent/services/agentProviderStatusService.interface.ts";

export const desktopAgentWindowFeatures = [
  "connect",
  "manage",
  "message-center"
] as const;

export type DesktopAgentWindowFeature =
  (typeof desktopAgentWindowFeatures)[number];

export interface StandaloneAgentWindowBootstrap {
  agentFeature: DesktopAgentWindowFeature | null;
  agentSessionId: string | null;
  agentTargetId: string | null;
  agents: readonly AgentGUIAgent[] | null;
  autoSubmit: boolean;
  draftPrompt: string | null;
  fusionWindowId: string | null;
  provider: DesktopAgentGUIProvider | null;
  providerStatusSnapshot: AgentProviderStatusSnapshot | null;
  userProjectPath: string | null;
}

export interface StandaloneAgentWindowLaunchPayloadInput {
  agentFeature?: DesktopAgentWindowFeature | null;
  agentSessionId?: string | null;
  agentTargetId?: string | null;
  agents?: readonly AgentGUIAgent[] | null;
  autoSubmit?: boolean;
  draftPrompt?: string | null;
  provider?: string | null;
  providerStatusSnapshot?: AgentProviderStatusSnapshot | null;
  userProjectPath?: string | null;
}

/**
 * Renderer-owned Agent launch contract. Electron main transports this value
 * opaquely and never branches on its feature, provider, or bootstrap fields.
 */
export function createStandaloneAgentWindowLaunchPayload(
  input: StandaloneAgentWindowLaunchPayloadInput
): Record<string, unknown> {
  const agentSessionId = readOptionalString(input.agentSessionId);
  const agentTargetId = readOptionalString(input.agentTargetId);
  const draftPrompt = readOptionalString(input.draftPrompt);
  const provider = readAgentProvider(input.provider);
  const userProjectPath = readOptionalString(input.userProjectPath);
  return {
    ...(isDesktopAgentWindowFeature(input.agentFeature)
      ? { agentFeature: input.agentFeature }
      : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    ...(agentTargetId ? { agentTargetId } : {}),
    ...(input.agents === undefined || input.agents === null
      ? {}
      : { agents: input.agents }),
    ...(draftPrompt
      ? {
          ...(input.autoSubmit === true ? { autoSubmit: true } : {}),
          draftPrompt
        }
      : {}),
    ...(provider ? { provider } : {}),
    ...(input.providerStatusSnapshot
      ? { providerStatusSnapshot: input.providerStatusSnapshot }
      : {}),
    ...(userProjectPath ? { userProjectPath } : {})
  };
}

export function resolveStandaloneAgentWindowBootstrap(
  intent: DesktopWindowIntent
): StandaloneAgentWindowBootstrap {
  const agentIntent = intent.kind === "agent" ? intent : null;
  const payload = asRecord(agentIntent?.launchPayload);
  return {
    agentFeature: readAgentWindowFeature(payload.agentFeature),
    agentSessionId:
      readOptionalString(payload.agentSessionId) ??
      agentIntent?.resourceID ??
      null,
    agentTargetId: readOptionalString(payload.agentTargetId),
    agents: Array.isArray(payload.agents)
      ? normalizeAgentDirectory(payload.agents)
      : null,
    autoSubmit: payload.autoSubmit === true,
    draftPrompt: readOptionalString(payload.draftPrompt),
    fusionWindowId: agentIntent?.windowInstanceID ?? null,
    provider: readAgentProvider(payload.provider),
    providerStatusSnapshot: normalizeProviderStatusSnapshot(
      payload.providerStatusSnapshot
    ),
    userProjectPath: readOptionalString(payload.userProjectPath)
  };
}

export function resolveStandaloneAgentInitialActivation(input: {
  agentSessionId: string | null;
  agentTargetId: string | null;
  autoSubmit: boolean;
  draftPrompt: string | null;
  provider: DesktopAgentGUIProvider;
  userProjectPath: string | null;
}): WorkbenchHostActivation | null {
  if (input.agentSessionId) {
    return {
      payload: { agentSessionId: input.agentSessionId },
      sequence: 1,
      type: desktopAgentGUIOpenSessionActivationType
    };
  }
  const draftPrompt = input.draftPrompt?.trim() || "";
  if (!draftPrompt) {
    return null;
  }
  return {
    payload: {
      ...(input.agentTargetId ? { agentTargetId: input.agentTargetId } : {}),
      ...(input.autoSubmit ? { autoSubmit: true } : {}),
      draftPrompt,
      provider: input.provider,
      ...(input.userProjectPath
        ? { userProjectPath: input.userProjectPath }
        : {})
    },
    sequence: 1,
    type: desktopAgentGUIPrefillPromptActivationType
  };
}

export function isDesktopAgentWindowFeature(
  value: unknown
): value is DesktopAgentWindowFeature {
  return desktopAgentWindowFeatures.some((feature) => feature === value);
}

function readAgentWindowFeature(
  value: unknown
): DesktopAgentWindowFeature | null {
  return isDesktopAgentWindowFeature(value) ? value : null;
}

const agentProviders = [
  "claude-code",
  "codex",
  "tutti-agent",
  "cursor",
  "nexight",
  "hermes",
  "openclaw",
  "opencode"
] as const satisfies readonly WorkspaceAgentProvider[];

function readAgentProvider(
  value: unknown
): (WorkspaceAgentProvider & AgentGUIProvider) | null {
  return typeof value === "string" &&
    agentProviders.includes(value.trim() as WorkspaceAgentProvider)
    ? (value.trim() as WorkspaceAgentProvider & AgentGUIProvider)
    : null;
}

function normalizeAgentDirectory(values: readonly unknown[]): AgentGUIAgent[] {
  const normalized: AgentGUIAgent[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const agent = readRecord(value);
    const agentTargetId = readOptionalString(agent?.agentTargetId);
    const name = readOptionalString(agent?.name);
    const iconUrl = readOptionalString(agent?.iconUrl);
    const provider = readAgentProvider(agent?.provider);
    const availability = normalizeAgentAvailability(agent?.availability);
    if (
      !agentTargetId ||
      !name ||
      !iconUrl ||
      !provider ||
      !availability ||
      seen.has(agentTargetId)
    ) {
      continue;
    }
    seen.add(agentTargetId);
    const owner = readRecord(agent?.owner);
    const ownerName = readOptionalString(owner?.name);
    const ownerAvatarUrl = readOptionalString(owner?.avatarUrl);
    const description = readOptionalString(agent?.description);
    normalized.push({
      agentTargetId,
      availability,
      ...(description ? { description } : {}),
      iconUrl,
      name,
      ...(ownerName || ownerAvatarUrl
        ? {
            owner: {
              ...(ownerAvatarUrl ? { avatarUrl: ownerAvatarUrl } : {}),
              ...(ownerName ? { name: ownerName } : {})
            }
          }
        : {}),
      provider
    });
  }
  return normalized;
}

function normalizeAgentAvailability(
  value: unknown
): AgentGUIAgentAvailability | null {
  const availability = readRecord(value);
  const status = availability?.status;
  if (
    !availability ||
    (status !== "ready" &&
      status !== "checking" &&
      status !== "coming_soon" &&
      status !== "not_installed" &&
      status !== "auth_required" &&
      status !== "unavailable")
  ) {
    return null;
  }
  const pendingAction = availability.pendingAction;
  const reason = readOptionalString(availability.reason);
  return {
    ...(pendingAction === "install" ||
    pendingAction === "login" ||
    pendingAction === "refresh"
      ? { pendingAction }
      : {}),
    ...(reason ? { reason } : {}),
    status
  };
}

function normalizeProviderStatusSnapshot(
  value: unknown
): AgentProviderStatusSnapshot | null {
  const snapshot = readRecord(value);
  const capturedAt = readOptionalString(snapshot?.capturedAt);
  if (!snapshot || !capturedAt) {
    return null;
  }
  return {
    capturedAt,
    defaultProvider: readAgentProvider(snapshot.defaultProvider),
    error: readOptionalString(snapshot.error),
    isLoading: snapshot.isLoading === true,
    pendingActions: Array.isArray(snapshot.pendingActions)
      ? snapshot.pendingActions.flatMap((pending) => {
          const entry = readRecord(pending);
          const actionId = readOptionalString(entry?.actionId);
          const provider = readAgentProvider(entry?.provider);
          return actionId && provider ? [{ actionId, provider }] : [];
        })
      : [],
    statuses: Array.isArray(snapshot.statuses)
      ? snapshot.statuses.flatMap((status) => {
          const normalized = normalizeProviderStatus(status);
          return normalized ? [normalized] : [];
        })
      : []
  };
}

function normalizeProviderStatus(value: unknown): AgentProviderStatus | null {
  const status = readRecord(value);
  const provider = readAgentProvider(status?.provider);
  const availability = normalizeProviderAvailability(status?.availability);
  const cli = normalizeProviderCliStatus(status?.cli);
  const adapter = normalizeProviderAdapterStatus(status?.adapter);
  const auth = normalizeProviderAuthStatus(status?.auth);
  if (
    !status ||
    !provider ||
    !availability ||
    !cli ||
    !adapter ||
    !auth ||
    !Array.isArray(status.actions)
  ) {
    return null;
  }
  return {
    actions: status.actions.flatMap((action) => {
      const normalized = normalizeProviderAction(action);
      return normalized ? [normalized] : [];
    }),
    adapter,
    auth,
    availability,
    cli,
    provider
  };
}

function normalizeProviderAvailability(
  value: unknown
): AgentProviderStatus["availability"] | null {
  const availability = readRecord(value);
  const status = availability?.status;
  if (
    !availability ||
    (status !== "ready" &&
      status !== "not_installed" &&
      status !== "auth_required" &&
      status !== "unsupported" &&
      status !== "unknown")
  ) {
    return null;
  }
  const checkedAt = readOptionalString(availability.checkedAt);
  const reasonCode = readOptionalString(availability.reasonCode);
  return {
    ...(checkedAt ? { checkedAt } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    status
  };
}

function normalizeProviderCliStatus(
  value: unknown
): AgentProviderStatus["cli"] | null {
  const cli = readRecord(value);
  if (!cli || typeof cli.installed !== "boolean") {
    return null;
  }
  const binaryPath = readOptionalString(cli.binaryPath);
  const minVersion = readOptionalString(cli.minVersion);
  const version = readOptionalString(cli.version);
  return {
    ...(binaryPath ? { binaryPath } : {}),
    installed: cli.installed,
    ...(minVersion ? { minVersion } : {}),
    ...(version ? { version } : {})
  };
}

function normalizeProviderAdapterStatus(
  value: unknown
): AgentProviderStatus["adapter"] | null {
  const adapter = readRecord(value);
  if (
    !adapter ||
    typeof adapter.installed !== "boolean" ||
    !Array.isArray(adapter.command) ||
    !adapter.command.every((part) => typeof part === "string")
  ) {
    return null;
  }
  const binaryPath = readOptionalString(adapter.binaryPath);
  const requiredVersion = readOptionalString(adapter.requiredVersion);
  const version = readOptionalString(adapter.version);
  return {
    ...(binaryPath ? { binaryPath } : {}),
    command: adapter.command,
    installed: adapter.installed,
    ...(requiredVersion ? { requiredVersion } : {}),
    ...(version ? { version } : {})
  };
}

function normalizeProviderAuthStatus(
  value: unknown
): AgentProviderStatus["auth"] | null {
  const auth = readRecord(value);
  if (
    !auth ||
    (auth.status !== "authenticated" &&
      auth.status !== "required" &&
      auth.status !== "unknown")
  ) {
    return null;
  }
  const accountLabel = readOptionalString(auth.accountLabel);
  const authMethod = readOptionalString(auth.authMethod);
  return {
    ...(accountLabel ? { accountLabel } : {}),
    ...(authMethod ? { authMethod } : {}),
    status: auth.status
  };
}

function normalizeProviderAction(value: unknown): AgentProviderAction | null {
  const action = readRecord(value);
  if (
    !action ||
    (action.id !== "install" &&
      action.id !== "login" &&
      action.id !== "refresh") ||
    (action.kind !== "daemon_action" &&
      action.kind !== "terminal_command" &&
      action.kind !== "refresh")
  ) {
    return null;
  }
  if (action.kind !== "terminal_command") {
    return { id: action.id, kind: action.kind };
  }
  const command = readRecord(action.command);
  const input = readOptionalString(command?.input);
  if (!input) {
    return null;
  }
  const cwd = readOptionalString(command?.cwd);
  return {
    command: { ...(cwd ? { cwd } : {}), input },
    id: action.id,
    kind: action.kind
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return readRecord(value) ?? {};
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
