import type { WorkspaceAgentSession } from "@tutti-os/client-tuttid-ts";
import type {
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type {
  AgentHostAgentSession,
  AgentHostAgentSessionComposerSettings as SharedAgentHostAgentSessionComposerSettings
} from "@shared/contracts/dto";
import {
  isDesktopAgentGUIProvider,
  normalizeDesktopAgentGUIProvider,
  type DesktopAgentGUIProvider
} from "../../desktopAgentGUINodeState.ts";

export interface AgentHostWorkspaceAgentMessage {
  agentSessionId: string;
  completedAtUnixMs?: number;
  id: number;
  kind: string;
  messageId: string;
  occurredAtUnixMs: number;
  payload: Record<string, unknown>;
  role: string;
  startedAtUnixMs?: number;
  status?: string;
  turnId: string;
  version: number;
  workspaceId: string;
}

export type AgentHostAgentSessionComposerSettings =
  SharedAgentHostAgentSessionComposerSettings;

export interface AgentHostAgentSessionComposerSettingsInput {
  model?: string | null;
  permissionModeId?: string | null;
  planMode?: boolean | null;
  reasoningEffort?: string | null;
  speed?: string | null;
}

export interface AgentHostAgentSessionStateDefaults {
  runtimeContext?: Record<string, unknown>;
  settings?: AgentHostAgentSessionComposerSettings;
}

const unsupportedDesktopAgentGUIProviderCode = "agent.provider_unsupported";

export function agentMessageFromCore(
  message: AgentActivityMessage
): AgentHostWorkspaceAgentMessage {
  return {
    agentSessionId: message.agentSessionId,
    completedAtUnixMs: message.completedAtUnixMs ?? undefined,
    id: message.id ?? message.version,
    kind: message.kind,
    messageId: message.messageId,
    occurredAtUnixMs: message.occurredAtUnixMs,
    payload: recordValue(message.payload) ?? {},
    role: message.role,
    startedAtUnixMs: message.startedAtUnixMs ?? undefined,
    status: message.status ?? undefined,
    turnId: message.turnId,
    version: message.version,
    workspaceId: message.workspaceId ?? ""
  };
}

export function cloneAgentMessage(
  message: AgentHostWorkspaceAgentMessage
): AgentHostWorkspaceAgentMessage {
  return {
    ...message,
    payload: { ...message.payload }
  };
}

export function pathFromFileReadPayload(payload: {
  path?: string;
  uri?: string;
}): string {
  if (payload.path) {
    return payload.path;
  }
  if (payload.uri?.startsWith("file://")) {
    return decodeURIComponent(new URL(payload.uri).pathname);
  }
  return payload.uri ?? "";
}

export function agentSessionStateDefaultsFromSettings(
  settings: AgentHostAgentSessionComposerSettingsInput | null | undefined
): AgentHostAgentSessionStateDefaults | null {
  if (!settings) {
    return null;
  }
  const normalizedSettings = normalizeComposerSettings(settings);
  return {
    settings: normalizedSettings,
    runtimeContext: composerRuntimeContextFromSettings(normalizedSettings)
  };
}

export function normalizeComposerSettings(
  settings: AgentHostAgentSessionComposerSettingsInput | null | undefined
): AgentHostAgentSessionComposerSettings {
  return {
    model: normalizedOptionalString(settings?.model),
    permissionModeId: resolveComposerPermissionMode(settings),
    planMode: Boolean(settings?.planMode),
    reasoningEffort: normalizedOptionalString(settings?.reasoningEffort),
    speed: normalizedOptionalString(settings?.speed)
  };
}

export function resolveComposerPermissionMode(
  settings: AgentHostAgentSessionComposerSettingsInput | null | undefined
): string | null {
  return normalizedOptionalString(settings?.permissionModeId);
}

export function toTuttidComposerSettings(
  settings: AgentHostAgentSessionComposerSettings | null | undefined
): AgentHostAgentSessionComposerSettings {
  const normalizedSettings = normalizeComposerSettings(settings);
  return {
    ...normalizedSettings,
    permissionModeId: resolveComposerPermissionMode(settings)
  };
}

export function resolveDesktopAgentGUIProvider(
  provider: string | null | undefined
): DesktopAgentGUIProvider {
  const rawProvider = provider?.trim();
  if (!rawProvider) {
    return "codex";
  }
  const normalizedProvider = normalizeDesktopAgentGUIProvider(rawProvider);
  if (isDesktopAgentGUIProvider(rawProvider)) {
    return normalizedProvider;
  }
  throw Object.assign(
    new Error("Tutti does not support this agent session provider."),
    {
      code: unsupportedDesktopAgentGUIProviderCode,
      debugMessage: `Unsupported desktop agent provider: ${rawProvider}`
    }
  );
}

export function toAgentHostAgentSessionFromCore(
  workspaceId: string,
  session: AgentActivitySession,
  options: {
    cwd?: string | null;
    permissionModeId?: string | null;
  } = {}
): AgentHostAgentSession {
  return {
    agentSessionId: session.agentSessionId,
    createdAtUnixMs: session.createdAtUnixMs ?? 0,
    cwd: options.cwd ?? session.cwd ?? "/",
    permissionModeId: options.permissionModeId ?? undefined,
    pinnedAtUnixMs: session.pinnedAtUnixMs,
    provider: normalizeDesktopAgentGUIProvider(session.provider),
    providerSessionId: session.providerSessionId ?? session.agentSessionId,
    resumable: session.resumable ?? false,
    status: toAgentHostAgentSessionStatus(session.status),
    title: session.title ?? undefined,
    updatedAtUnixMs:
      session.updatedAtUnixMs ??
      session.lastEventUnixMs ??
      session.createdAtUnixMs ??
      0,
    visible: session.visible ?? true,
    workspaceId
  };
}

export function toAgentHostAgentSessionState(
  workspaceId: string,
  session: WorkspaceAgentSession,
  options: {
    agentSessionId?: string | null;
    defaults?: AgentHostAgentSessionStateDefaults;
  } = {}
) {
  const agentSessionId = options.agentSessionId?.trim() || session.id;
  const settings = session.settings
    ? normalizeComposerSettings(session.settings)
    : options.defaults?.settings;
  const runtimeContext =
    session.runtimeContext ?? options.defaults?.runtimeContext;
  return {
    agentSessionId,
    ...(settings ? { settings } : {}),
    ...(session.permissionConfig
      ? { permissionConfig: session.permissionConfig }
      : {}),
    ...(runtimeContext ? { runtimeContext } : {}),
    permissionModeId: resolveComposerPermissionMode(settings) ?? undefined,
    provider: session.provider,
    providerSessionId: session.id,
    resumable: session.resumable ?? false,
    status: toAgentHostAgentSessionStatus(session.status),
    ...(session.turnLifecycle ? { turnLifecycle: session.turnLifecycle } : {}),
    ...(session.submitAvailability
      ? { submitAvailability: session.submitAvailability }
      : {}),
    ...(session.lastError ? { lastError: session.lastError } : {}),
    updatedAtUnixMs: toUnixMs(session.updatedAt ?? session.createdAt),
    workspaceId
  };
}

export function agentHostWorkspaceSessionFromCore(
  workspaceId: string,
  session: AgentActivitySession,
  id: number,
  options: { agentSessionId?: string | null } = {}
) {
  const agentSessionId =
    options.agentSessionId?.trim() || session.agentSessionId;
  return {
    agentSessionId,
    createdAtUnixMs: session.createdAtUnixMs,
    cwd: session.cwd ?? "/",
    endedAtUnixMs: session.endedAtUnixMs,
    effectiveStatus: toAgentHostWorkspaceAgentEffectiveStatus(session.status),
    id,
    lifecycleStatus:
      session.status === "failed"
        ? "failed"
        : session.status === "completed" || session.status === "canceled"
          ? "ended"
          : "active",
    presenceId: 1,
    pinnedAtUnixMs: session.pinnedAtUnixMs,
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? session.agentSessionId,
    resumable: session.resumable ?? false,
    sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
    startedAtUnixMs: session.startedAtUnixMs,
    status: toAgentHostAgentSessionStatus(session.status),
    turnPhase: toAgentHostWorkspaceAgentTurnPhase(session.status),
    workspaceId,
    ...(session.lastError
      ? {
          syncState: failedAgentSyncStateFromCore(workspaceId, session, {
            agentSessionId
          })
        }
      : {}),
    title: session.title ?? undefined,
    updatedAtUnixMs: session.updatedAtUnixMs ?? session.lastEventUnixMs,
    userId: "local"
  };
}

export function agentSessionActivationError(
  session: Pick<
    AgentActivitySession | WorkspaceAgentSession,
    "lastError" | "status"
  >
):
  | {
      code: string;
      debugMessage: string;
      message: string;
    }
  | undefined {
  const message = session.lastError?.trim();
  if (!message || session.status !== "failed") {
    return undefined;
  }
  return {
    code: "agent_session_start_failed",
    debugMessage: message,
    message
  };
}

export function toAgentHostAgentSessionStatus(status: string): string {
  switch (status) {
    case "created":
      return "ready";
    case "running":
      return "working";
    case "waiting":
      return "ready";
    default:
      return status;
  }
}

export function isDenyPermissionOption(optionId: string): boolean {
  return /^(abort|cancel|cancelled|canceled|deny|denied|reject|rejected|no)$/i.test(
    optionId.trim()
  );
}

export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function unavailableHostMethod(name: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new Error(`${name} is not available in the Tutti Agent GUI host.`)
    );
}

function composerRuntimeContextFromSettings(
  settings: AgentHostAgentSessionComposerSettings
): Record<string, unknown> {
  const model = normalizedOptionalString(settings.model);
  const reasoningEffort = normalizedOptionalString(settings.reasoningEffort);
  const speed = normalizedOptionalString(settings.speed);
  const permissionModeId = resolveComposerPermissionMode(settings);
  return {
    configOptions: [
      {
        currentValue: model,
        id: "model",
        options: model ? [{ name: model, value: model }] : []
      },
      {
        currentValue: reasoningEffort,
        id: "reasoning_effort",
        options: reasoningEffortOptions(reasoningEffort)
      },
      {
        currentValue: speed,
        id: "speed",
        options: speed ? [{ name: speed, value: speed }] : []
      }
    ],
    model,
    permissionModeId,
    reasoningEffort,
    speed
  };
}

function reasoningEffortOptions(
  selected: string | null
): Array<{ name: string; value: string }> {
  const values = ["minimal", "low", "medium", "high", "xhigh"];
  const options = values.map((value) => ({
    name: reasoningEffortLabel(value),
    value
  }));
  return selected && !values.includes(selected)
    ? [...options, { name: reasoningEffortLabel(selected), value: selected }]
    : options;
}

function reasoningEffortLabel(value: string): string {
  switch (value) {
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "X-High";
    default:
      return value;
  }
}

function normalizedOptionalString(
  value: string | null | undefined
): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function failedAgentSyncStateFromCore(
  workspaceId: string,
  session: AgentActivitySession,
  options: { agentSessionId?: string | null } = {}
) {
  const agentSessionId =
    options.agentSessionId?.trim() || session.agentSessionId;
  return {
    agentSessionId,
    lastError: session.lastError?.trim(),
    status: "failed",
    updatedAtUnixMs: session.updatedAtUnixMs ?? session.lastEventUnixMs,
    workspaceId
  };
}

function toAgentHostWorkspaceAgentEffectiveStatus(status: string): string {
  switch (status) {
    case "created":
      return "ready";
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    default:
      return status;
  }
}

function toAgentHostWorkspaceAgentTurnPhase(status: string): string {
  switch (status) {
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

function toUnixMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}
