import type {
  AgentActivityAdapter,
  AgentActivityComposerOptions,
  AgentActivityComposerPermissionConfig,
  AgentActivityComposerSettingOption,
  AgentActivityComposerSkillOption,
  AgentActivityMessage,
  AgentActivitySession
} from "@tutti-os/agent-activity-core";
import type {
  TuttidClient,
  WorkspaceAgentProvider,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";

export interface CreateDesktopAgentActivityAdapterInput {
  tuttidClient: TuttidClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
}

export function createDesktopAgentActivityAdapter({
  tuttidClient,
  runtimeApi
}: CreateDesktopAgentActivityAdapterInput): AgentActivityAdapter {
  return {
    async listSessions(input) {
      const response = await tuttidClient.listWorkspaceAgentSessions(
        input.workspaceId
      );
      return {
        sessions: response.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(input.workspaceId, session)
        )
      };
    },
    async listSessionMessages(input) {
      const response = await tuttidClient.listWorkspaceAgentSessionMessages(
        input.workspaceId,
        input.agentSessionId,
        {
          afterVersion: input.afterVersion ?? 0,
          beforeVersion: input.beforeVersion,
          order: input.order,
          limit: input.limit
        }
      );
      return {
        hasMore: response.hasMore,
        latestVersion: response.latestVersion,
        messages: response.messages.map((message) =>
          agentActivityMessageFromTuttidMessage(input.workspaceId, message)
        )
      };
    },
    async loadComposerOptions(input) {
      const cwd = input.cwd?.trim();
      const result = await tuttidClient.getAgentProviderComposerOptions(
        workspaceAgentProvider(input.provider),
        {
          ...(cwd ? { cwd } : {}),
          settings: input.settings ?? {}
        }
      );
      return agentActivityComposerOptionsFromTuttidResult(
        input.provider,
        result
      );
    },
    subscribeSessionEvents(input) {
      void runtimeApi.logTerminalDiagnostic({
        details: {
          error: "workspace agent session event subscription is unavailable"
        },
        event: "agent.gui.session_event.subscribe.unavailable",
        level: "warn",
        workspaceId: input.workspaceId
      });
      return Promise.reject(
        new Error("Workspace agent session event subscription is unavailable.")
      );
    },
    async createSession(input) {
      const session = await tuttidClient.createWorkspaceAgentSession(
        input.workspaceId,
        {
          agentSessionId:
            input.agentSessionId?.trim() ||
            createDesktopAgentActivitySessionId(),
          cwd: input.cwd ?? null,
          initialContent: input.initialContent ?? [],
          model: input.model ?? null,
          planMode: input.planMode ?? null,
          permissionModeId: input.permissionModeId ?? null,
          provider: workspaceAgentProvider(input.provider),
          reasoningEffort: input.reasoningEffort ?? null,
          speed: input.speed ?? null,
          title: input.title ?? null,
          visible: input.visible ?? null
        }
      );
      return agentActivitySessionFromTuttidSession(input.workspaceId, session);
    },
    async sendInput(input) {
      const session = await tuttidClient.sendWorkspaceAgentSessionInput(
        input.workspaceId,
        input.agentSessionId,
        {
          content: input.content
        }
      );
      return agentActivitySessionFromTuttidSession(input.workspaceId, session);
    },
    async cancelSession(input) {
      const result = await tuttidClient.cancelWorkspaceAgentSessionWithResult(
        input.workspaceId,
        input.agentSessionId
      );
      return {
        canceled: result.cancel.canceled,
        reason: result.cancel.reason,
        session: agentActivitySessionFromTuttidSession(
          input.workspaceId,
          result.session
        )
      };
    },
    async submitInteractive(input) {
      return await tuttidClient.submitWorkspaceAgentInteractive(
        input.workspaceId,
        input.agentSessionId,
        input.requestId,
        {
          action: input.action ?? null,
          optionId: input.optionId ?? null,
          payload: input.payload ?? null
        }
      );
    },
    async deleteSession(input) {
      return await tuttidClient.deleteWorkspaceAgentSession(
        input.workspaceId,
        input.agentSessionId
      );
    }
  };
}

function createDesktopAgentActivitySessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}

export function agentActivitySessionFromTuttidSession(
  workspaceId: string,
  session: WorkspaceAgentSession
): AgentActivitySession {
  const createdAtUnixMs = toUnixMs(session.createdAt);
  const updatedAtUnixMs = toUnixMs(session.updatedAt ?? session.createdAt);
  const endedAtUnixMs = toOptionalUnixMs(session.endedAt);
  return {
    workspaceId,
    agentSessionId: session.id,
    provider: session.provider,
    providerSessionId: session.id,
    cwd: session.cwd ?? "/",
    title: session.title ?? "",
    status: session.status,
    visible: session.visible ?? true,
    resumable: session.resumable ?? false,
    lastError: session.lastError ?? null,
    lastEventUnixMs: updatedAtUnixMs,
    pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
    startedAtUnixMs: createdAtUnixMs,
    ...(endedAtUnixMs !== undefined ? { endedAtUnixMs } : {}),
    createdAtUnixMs,
    updatedAtUnixMs
  };
}

export function agentActivityMessageFromTuttidMessage(
  workspaceId: string,
  message: WorkspaceAgentSessionMessage
): AgentActivityMessage {
  return {
    workspaceId,
    agentSessionId: message.agentSessionId,
    completedAtUnixMs: message.completedAtUnixMs ?? undefined,
    id: message.id,
    kind: message.kind,
    messageId: message.messageId,
    occurredAtUnixMs: message.occurredAtUnixMs ?? undefined,
    payload: recordValue(message.payload),
    role: message.role,
    startedAtUnixMs: message.startedAtUnixMs ?? undefined,
    status: message.status ?? undefined,
    turnId: message.turnId ?? undefined,
    version: message.version
  };
}

function toUnixMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toOptionalUnixMs(
  value: string | null | undefined
): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function agentActivityComposerOptionsFromTuttidResult(
  provider: string,
  value: unknown
): AgentActivityComposerOptions {
  const result = recordValue(value);
  const runtimeContext = recordValue(result.runtimeContext);
  const rawConfigOptions = Array.isArray(runtimeContext.configOptions)
    ? runtimeContext.configOptions
    : [];
  const modelConfig = recordValue(result.modelConfig);
  const reasoningConfig = recordValue(result.reasoningConfig);
  const speedConfig = recordValue(result.speedConfig);
  const modelsFromConfig = settingOptionsFromComposerConfig(modelConfig);
  // The live agent's advertised model list reflects the models the running
  // session can actually use (e.g. concrete ids like Opus 4.6), so it takes
  // precedence over the pre-session static catalog when present. The static
  // list remains the fallback before a session has advertised its options.
  const modelsFromLiveConfig = settingOptionsFromConfigOption(
    rawConfigOptions,
    ["model"]
  );
  const reasoningEffortsFromConfig =
    settingOptionsFromComposerConfig(reasoningConfig);
  const speedsFromConfig = settingOptionsFromComposerConfig(speedConfig);
  const skillsFromResult = skillOptionsFromValue(result.skills);
  const skillsFromRuntimeContext = skillOptionsFromValue(runtimeContext.skills);
  return {
    provider: normalizeText(result.provider) ?? provider,
    models:
      modelsFromLiveConfig.length > 0 ? modelsFromLiveConfig : modelsFromConfig,
    reasoningEfforts:
      reasoningEffortsFromConfig.length > 0
        ? reasoningEffortsFromConfig
        : settingOptionsFromConfigOption(rawConfigOptions, [
            "reasoning_effort",
            "model_reasoning_effort",
            "effort"
          ]),
    speeds:
      speedsFromConfig.length > 0
        ? speedsFromConfig
        : settingOptionsFromConfigOption(rawConfigOptions, [
            "service_tier",
            "speed",
            "fast"
          ]),
    modelConfigurable: modelConfig.configurable === true,
    reasoningConfigurable: reasoningConfig.configurable === true,
    speedConfigurable: speedConfig.configurable === true,
    permissionConfig: permissionConfigFromValue(result.permissionConfig),
    runtimeContext,
    skills:
      skillsFromResult.length > 0 ? skillsFromResult : skillsFromRuntimeContext,
    loadedAtUnixMs: Date.now()
  };
}

function settingOptionsFromComposerConfig(
  config: Record<string, unknown>
): AgentActivityComposerSettingOption[] {
  const options = settingOptionsFromRawOptions(config.options, {
    labelKeys: ["label", "name", "displayName"],
    valueKeys: ["value", "id"]
  });
  const currentValue = normalizeText(
    config.currentValue ?? config.current_value ?? config.defaultValue
  );
  return appendCurrentOption(options, currentValue);
}

function settingOptionsFromConfigOption(
  rawConfigOptions: unknown[],
  ids: readonly string[]
): AgentActivityComposerSettingOption[] {
  const idSet = new Set(ids);
  const configOption =
    rawConfigOptions.map(recordValue).find((option) => {
      const id = normalizeText(option.id);
      return id ? idSet.has(id) : false;
    }) ?? null;
  if (!configOption) {
    return [];
  }
  const options = settingOptionsFromRawOptions(configOption.options, {
    labelKeys: ["name", "label", "displayName"],
    valueKeys: ["value", "id"]
  });
  const currentValue = normalizeText(
    configOption.currentValue ?? configOption.current_value
  );
  return appendCurrentOption(options, currentValue);
}

function settingOptionsFromRawOptions(
  value: unknown,
  keys: {
    labelKeys: readonly string[];
    valueKeys: readonly string[];
  }
): AgentActivityComposerSettingOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AgentActivityComposerSettingOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = recordValue(item);
    const optionValue = firstTextValue(record, keys.valueKeys);
    if (!optionValue || seen.has(optionValue)) {
      continue;
    }
    seen.add(optionValue);
    const label = firstTextValue(record, keys.labelKeys) ?? optionValue;
    const description = normalizeText(record.description);
    options.push({
      value: optionValue,
      label,
      ...(description ? { description } : {})
    });
  }
  return options;
}

function appendCurrentOption(
  options: AgentActivityComposerSettingOption[],
  currentValue: string | null
): AgentActivityComposerSettingOption[] {
  if (
    !currentValue ||
    options.some((option) => option.value === currentValue)
  ) {
    return options;
  }
  return [...options, { value: currentValue, label: currentValue }];
}

function permissionConfigFromValue(
  value: unknown
): AgentActivityComposerPermissionConfig | null {
  const config = recordValue(value);
  if (Object.keys(config).length === 0) {
    return null;
  }
  const modes = Array.isArray(config.modes) ? config.modes : [];
  const parsedModes: AgentActivityComposerPermissionConfig["modes"] = [];
  for (const item of modes) {
    const mode = recordValue(item);
    const id = normalizeText(mode.id);
    if (!id) {
      continue;
    }
    const label = normalizeText(mode.label);
    const description = normalizeText(mode.description);
    const semantic = normalizeText(mode.semantic);
    parsedModes.push({
      id,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(semantic ? { semantic } : {})
    });
  }
  const defaultValue = normalizeText(
    config.defaultValue ?? config.currentValue
  );
  return {
    configurable: Boolean(config.configurable),
    ...(defaultValue ? { defaultValue } : {}),
    modes: parsedModes
  };
}

function skillOptionsFromValue(
  value: unknown
): AgentActivityComposerSkillOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AgentActivityComposerSkillOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = recordValue(item);
    const name = normalizeText(record.name);
    const trigger = normalizeText(record.trigger);
    const sourceKind = normalizeSkillSourceKind(record.sourceKind);
    if (!name || !trigger || !sourceKind || seen.has(trigger)) {
      continue;
    }
    seen.add(trigger);
    const description = normalizeText(record.description);
    const pluginName = normalizeText(record.pluginName);
    options.push({
      name,
      trigger,
      sourceKind,
      ...(description ? { description } : {}),
      ...(pluginName ? { pluginName } : {})
    });
  }
  return options;
}

function normalizeSkillSourceKind(
  value: unknown
): AgentActivityComposerSkillOption["sourceKind"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "project":
    case "personal":
    case "bundled":
    case "plugin":
    case "system":
    case "tutti-injected":
      return normalized;
    default:
      return null;
  }
}

function firstTextValue(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = normalizeText(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workspaceAgentProvider(value: string): WorkspaceAgentProvider {
  return value as WorkspaceAgentProvider;
}
