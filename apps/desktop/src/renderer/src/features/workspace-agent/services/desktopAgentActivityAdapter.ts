import type {
  AgentActivityAdapter,
  AgentActivityComposerCapabilityOption,
  AgentActivityComposerOptions,
  AgentActivityComposerPermissionConfig,
  AgentActivityComposerSettingOption,
  AgentActivityComposerSkillOption,
  AgentActivityMessage,
  AgentActivitySession,
  AgentPromptContentBlock
} from "@tutti-os/agent-activity-core";
import type {
  TuttidClient,
  AgentPromptContentBlock as TuttidAgentPromptContentBlock,
  WorkspaceAgentProvider,
  WorkspaceAgentSession,
  WorkspaceAgentSessionMessage
} from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import type { IAgentProviderStatusService } from "./agentProviderStatusService.interface";
import { getActiveLocale } from "../../../i18n/runtime.ts";
import { wrapLocalizedTuttidErrorIfSpecific } from "../../../lib/desktopErrors.ts";
import { shouldRefreshProviderStatusAfterSessionError } from "./internal/desktopAgentProviderStatusSync.ts";
import {
  normalizedTuttidMessageOccurredAtUnixMs,
  normalizedTuttidMessageTurnId
} from "./desktopAgentActivityMessageNormalization.ts";

export interface CreateDesktopAgentActivityAdapterInput {
  agentProviderStatusService?: Pick<IAgentProviderStatusService, "refresh">;
  agentSessionCreateRequestTimeoutMs?: number;
  composerOptionsRequestTimeoutMs?: number;
  tuttidClient: TuttidClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
}

const defaultAgentSessionCreateRequestTimeoutMs = 30_000;
const defaultComposerOptionsRequestTimeoutMs = 15_000;

export function createDesktopAgentActivityAdapter({
  agentProviderStatusService,
  agentSessionCreateRequestTimeoutMs = defaultAgentSessionCreateRequestTimeoutMs,
  composerOptionsRequestTimeoutMs = defaultComposerOptionsRequestTimeoutMs,
  tuttidClient,
  runtimeApi
}: CreateDesktopAgentActivityAdapterInput): AgentActivityAdapter {
  // At most one pre-warm draft per workspace. Switching plan/permission/model
  // updates this draft in place via the ACP protocol instead of tearing it
  // down and creating a brand new hidden session on every toggle.
  const claudeDrafts = new Map<string, ClaudeDraftSessionEntry>();

  const deleteClaudeDraft = (entry: ClaudeDraftSessionEntry): void => {
    if (entry.status === "promoted") {
      return;
    }
    entry.status = "disposed";
    if (claudeDrafts.get(entry.workspaceId) === entry) {
      claudeDrafts.delete(entry.workspaceId);
    }
    void entry.promise
      .then((session) =>
        tuttidClient.deleteWorkspaceAgentSession(entry.workspaceId, session.id)
      )
      .catch(() => undefined);
  };

  const createClaudeDraft = (
    input: ClaudeDraftInput,
    cwd: string | null,
    settingsKey: string
  ): Promise<WorkspaceAgentSession> => {
    const draftKey = claudeDraftKey({ ...input, cwd });
    const agentSessionId =
      normalizeText(input.agentSessionId) ??
      createDesktopAgentActivitySessionId();
    const promise = withAbortableRequestTimeout(
      (signal) =>
        tuttidClient.createWorkspaceAgentSession(
          input.workspaceId,
          {
            agentSessionId,
            cwd,
            initialContent: [],
            model: input.settings.model,
            permissionModeId: input.settings.permissionModeId,
            planMode: input.settings.planMode,
            provider: "claude-code",
            reasoningEffort: input.settings.reasoningEffort,
            speed: input.settings.speed,
            title: null,
            visible: false
          },
          { signal }
        ),
      {
        signal: input.signal,
        timeoutMessage: "Agent session create request timed out.",
        timeoutMs: agentSessionCreateRequestTimeoutMs
      }
    ).then((session) => sessionWithClaudeDraftContext(session, draftKey));
    const entry: ClaudeDraftSessionEntry = {
      cwd,
      promise,
      sessionId: agentSessionId,
      settingsKey,
      status: "starting",
      workspaceId: input.workspaceId
    };
    claudeDrafts.set(input.workspaceId, entry);
    void promise.then(
      (session) => {
        if (entry.status === "starting") {
          entry.status = "ready";
          entry.sessionId = session.id;
        }
      },
      () => {
        entry.status = "failed";
        if (claudeDrafts.get(input.workspaceId) === entry) {
          claudeDrafts.delete(input.workspaceId);
        }
      }
    );
    return promise;
  };

  const ensureClaudeDraft = (
    input: ClaudeDraftInput
  ): Promise<WorkspaceAgentSession> => {
    const cwd = input.cwd ?? null;
    const settingsKey = JSON.stringify(input.settings);
    const existing = claudeDrafts.get(input.workspaceId);
    if (
      existing &&
      existing.status !== "disposed" &&
      existing.status !== "failed" &&
      existing.cwd === cwd &&
      (!input.agentSessionId || existing.sessionId === input.agentSessionId)
    ) {
      if (existing.settingsKey === settingsKey) {
        return existing.promise;
      }
      // Settings changed (e.g. plan/permission mode toggled): patch the live
      // draft in place rather than recreating a session. The returned session
      // carries the refreshed permissionConfig/runtimeContext.
      const draftKey = claudeDraftKey({ ...input, cwd });
      existing.settingsKey = settingsKey;
      const updated = existing.promise.then((session) =>
        tuttidClient
          .updateWorkspaceAgentSessionSettings(input.workspaceId, session.id, {
            model: input.settings.model,
            permissionModeId: input.settings.permissionModeId,
            planMode: input.settings.planMode,
            reasoningEffort: input.settings.reasoningEffort,
            speed: input.settings.speed
          })
          .then((next) => sessionWithClaudeDraftContext(next, draftKey))
      );
      existing.promise = updated;
      void updated.then(
        (session) => {
          if (existing.status === "starting" || existing.status === "ready") {
            existing.status = "ready";
            existing.sessionId = session.id;
          }
        },
        () => {
          // Keep the existing draft if the in-place update fails; the final
          // settings are applied again when the draft is promoted on send.
        }
      );
      return updated;
    }
    if (existing) {
      deleteClaudeDraft(existing);
    }
    return createClaudeDraft(input, cwd, settingsKey);
  };

  const promoteClaudeDraft = async (
    input: Parameters<AgentActivityAdapter["createSession"]>[0]
  ): Promise<AgentActivitySession | null> => {
    const agentSessionId = input.agentSessionId?.trim();
    const initialContent = toTuttidPromptContentBlocks(
      input.initialContent ?? []
    );
    if (
      workspaceAgentProvider(input.provider) !== "claude-code" ||
      !agentSessionId ||
      initialContent.length === 0
    ) {
      return null;
    }
    const entry = claudeDrafts.get(input.workspaceId);
    if (
      !entry ||
      entry.sessionId !== agentSessionId ||
      isDeadDraftStatus(entry.status)
    ) {
      return null;
    }
    // entry.status can flip to "failed" while awaiting the create promise.
    await entry.promise;
    if (isDeadDraftStatus(entry.status)) {
      return null;
    }
    await tuttidClient.updateWorkspaceAgentSessionVisibility(
      input.workspaceId,
      agentSessionId,
      { visible: true }
    );
    entry.status = "promoted";
    if (claudeDrafts.get(input.workspaceId) === entry) {
      claudeDrafts.delete(input.workspaceId);
    }
    const result = await tuttidClient.sendWorkspaceAgentSessionInput(
      input.workspaceId,
      agentSessionId,
      {
        content: initialContent,
        ...(input.metadata ? { metadata: input.metadata } : {})
      }
    );
    return agentActivitySessionFromTuttidSession(
      input.workspaceId,
      result.session
    );
  };

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
      const result = await withAbortableRequestTimeout(
        (signal) =>
          tuttidClient.getAgentProviderComposerOptions(
            workspaceAgentProvider(input.provider),
            {
              ...(cwd ? { cwd } : {}),
              workspaceId: input.workspaceId,
              settings: input.settings ?? {}
            },
            { signal }
          ),
        {
          signal: input.signal,
          timeoutMessage: "Agent composer options request timed out.",
          timeoutMs: composerOptionsRequestTimeoutMs
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
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId?.trim() ?? null,
        event: "renderer_adapter.create.entered",
        metadata: input.metadata,
        provider: input.provider,
        workspaceId: input.workspaceId
      });
      try {
        const promoted = await promoteClaudeDraft(input);
        if (promoted) {
          reportDesktopAgentSubmitTrace(runtimeApi, {
            agentSessionId: promoted.agentSessionId,
            event: "renderer_adapter.create.promoted_draft",
            metadata: input.metadata,
            provider: promoted.provider,
            workspaceId: input.workspaceId
          });
          return promoted;
        }
        if (
          workspaceAgentProvider(input.provider) === "claude-code" &&
          (input.initialContent?.length ?? 0) > 0
        ) {
          const draft = await ensureClaudeDraft({
            agentSessionId: input.agentSessionId?.trim() ?? null,
            cwd: input.cwd ?? null,
            settings: normalizedClaudeDraftSettings({
              model: input.model,
              permissionModeId: input.permissionModeId,
              planMode: input.planMode,
              reasoningEffort: input.reasoningEffort,
              speed: input.speed
            }),
            signal: input.signal,
            workspaceId: input.workspaceId
          });
          const promotedDraft = await promoteClaudeDraft({
            ...input,
            agentSessionId: draft.id
          });
          if (promotedDraft) {
            return promotedDraft;
          }
        }
        const agentSessionId =
          input.agentSessionId?.trim() || createDesktopAgentActivitySessionId();
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId,
          event: "renderer_adapter.create.http_requested",
          metadata: input.metadata,
          provider: input.provider,
          workspaceId: input.workspaceId
        });
        const session = await withAbortableRequestTimeout(
          (signal) =>
            tuttidClient.createWorkspaceAgentSession(
              input.workspaceId,
              {
                agentSessionId,
                cwd: input.cwd ?? null,
                initialContent: toTuttidPromptContentBlocks(
                  input.initialContent ?? []
                ),
                initialDisplayPrompt: input.initialDisplayPrompt ?? null,
                ...(input.metadata ? { metadata: input.metadata } : {}),
                model: input.model ?? null,
                planMode: input.planMode ?? null,
                permissionModeId: input.permissionModeId ?? null,
                provider: workspaceAgentProvider(input.provider),
                reasoningEffort: input.reasoningEffort ?? null,
                speed: input.speed ?? null,
                title: input.title ?? null,
                visible: input.visible ?? null
              },
              { signal }
            ),
          {
            signal: input.signal,
            timeoutMessage: "Agent session create request timed out.",
            timeoutMs: agentSessionCreateRequestTimeoutMs
          }
        );
        reportDesktopAgentSubmitTrace(runtimeApi, {
          agentSessionId: session.id,
          event: "renderer_adapter.create.resolved",
          metadata: input.metadata,
          provider: session.provider,
          workspaceId: input.workspaceId,
          fields: { sessionStatus: session.status }
        });
        return agentActivitySessionFromTuttidSession(
          input.workspaceId,
          session
        );
      } catch (error) {
        const provider = workspaceAgentProvider(input.provider);
        if (shouldRefreshProviderStatusAfterSessionError(error)) {
          void agentProviderStatusService?.refresh([provider]).catch(() => {});
        }
        throw wrapLocalizedTuttidErrorIfSpecific(error, getActiveLocale());
      }
    },
    async sendInput(input) {
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        event: "renderer_adapter.send.entered",
        metadata: input.metadata,
        workspaceId: input.workspaceId
      });
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        event: "renderer_adapter.send.http_requested",
        metadata: input.metadata,
        workspaceId: input.workspaceId
      });
      const result = await tuttidClient.sendWorkspaceAgentSessionInput(
        input.workspaceId,
        input.agentSessionId,
        {
          content: toTuttidPromptContentBlocks(input.content),
          displayPrompt: input.displayPrompt ?? null,
          ...(input.metadata ? { metadata: input.metadata } : {})
        }
      );
      reportDesktopAgentSubmitTrace(runtimeApi, {
        agentSessionId: input.agentSessionId,
        event: "renderer_adapter.send.resolved",
        metadata: input.metadata,
        provider: result.session.provider,
        workspaceId: input.workspaceId,
        fields: {
          sessionStatus: result.session.status,
          turnId: result.turnId,
          turnPhase: result.turnLifecycle?.phase ?? null
        }
      });
      return {
        session: agentActivitySessionFromTuttidSession(
          input.workspaceId,
          result.session
        ),
        turnId: result.turnId,
        turnLifecycle: result.turnLifecycle,
        submitAvailability: result.submitAvailability
      };
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

function reportDesktopAgentSubmitTrace(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">,
  input: {
    agentSessionId: string | null;
    event: string;
    metadata: Record<string, unknown> | undefined;
    workspaceId: string;
    provider?: string | null;
    fields?: Record<string, unknown>;
  }
): void {
  const clientSubmitId = stringMetadata(input.metadata, "clientSubmitId");
  if (!clientSubmitId) {
    return;
  }
  const submittedAtUnixMs = numberMetadata(
    input.metadata,
    "clientSubmittedAtUnixMs"
  );
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details: {
          agentSessionId: input.agentSessionId,
          clientSubmitId,
          clientSubmittedAtUnixMs: submittedAtUnixMs,
          elapsedSinceClientSubmitMs:
            submittedAtUnixMs > 0
              ? Math.max(0, Date.now() - submittedAtUnixMs)
              : null,
          provider: input.provider ?? null,
          traceEvent: input.event,
          ...(input.fields ?? {})
        },
        event: "agent.submit.trace",
        level: "info",
        workspaceId: input.workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect agent submission.
  }
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): number {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

export function createDesktopAgentActivitySessionId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const fallbackHex = Math.random().toString(16).slice(2).padEnd(12, "0");
  return `00000000-0000-4000-8000-${fallbackHex.slice(0, 12)}`;
}

type ClaudeDraftStatus =
  | "starting"
  | "ready"
  | "failed"
  | "promoted"
  | "disposed";

interface ClaudeDraftSettings {
  model: string | null;
  permissionModeId: string | null;
  planMode: boolean | null;
  reasoningEffort: string | null;
  speed: string | null;
}

interface ClaudeDraftInput {
  agentSessionId?: string | null;
  cwd: string | null;
  settings: ClaudeDraftSettings;
  signal?: AbortSignal;
  workspaceId: string;
}

interface ClaudeDraftSessionEntry {
  cwd: string | null;
  settingsKey: string;
  promise: Promise<WorkspaceAgentSession>;
  sessionId: string;
  status: ClaudeDraftStatus;
  workspaceId: string;
}

function normalizedClaudeDraftSettings(
  settings:
    | {
        model?: string | null;
        permissionModeId?: string | null;
        planMode?: boolean | null;
        reasoningEffort?: string | null;
        speed?: string | null;
      }
    | null
    | undefined
): ClaudeDraftSettings {
  return {
    model: normalizeText(settings?.model) ?? null,
    permissionModeId: normalizeText(settings?.permissionModeId) ?? null,
    planMode: settings?.planMode ?? null,
    reasoningEffort: normalizeText(settings?.reasoningEffort) ?? null,
    speed: normalizeText(settings?.speed) ?? null
  };
}

function isDeadDraftStatus(status: ClaudeDraftStatus): boolean {
  return status === "disposed" || status === "failed";
}

function claudeDraftKey(input: ClaudeDraftInput): string {
  return JSON.stringify({
    cwd: input.cwd ?? "",
    settings: input.settings,
    workspaceId: input.workspaceId
  });
}

function sessionWithClaudeDraftContext(
  session: WorkspaceAgentSession,
  draftKey: string
): WorkspaceAgentSession {
  return {
    ...session,
    runtimeContext: {
      ...recordValue(session.runtimeContext),
      draftAgentSessionId: session.id,
      draftKey
    }
  };
}

function toTuttidPromptContentBlocks(
  content: readonly AgentPromptContentBlock[]
): TuttidAgentPromptContentBlock[] {
  return content.flatMap((block) => {
    if (block.type === "file") {
      throw new Error(
        "File prompt blocks must be uploaded before desktop submission."
      );
    }
    const nextBlock: TuttidAgentPromptContentBlock = { type: block.type };
    if (block.attachmentId !== undefined) {
      nextBlock.attachmentId = block.attachmentId;
    }
    if (block.data !== undefined) {
      nextBlock.data = block.data;
    }
    if (block.mimeType !== undefined) {
      nextBlock.mimeType =
        block.mimeType as TuttidAgentPromptContentBlock["mimeType"];
    }
    if (block.name !== undefined) {
      nextBlock.name = block.name;
    }
    if (block.path !== undefined) {
      nextBlock.path = block.path;
    }
    if (block.text !== undefined) {
      nextBlock.text = block.text;
    }
    return [nextBlock];
  });
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
    ...(session.turnLifecycle != null
      ? { turnLifecycle: session.turnLifecycle }
      : {}),
    ...(session.submitAvailability != null
      ? { submitAvailability: session.submitAvailability }
      : {}),
    lastError: session.lastError ?? null,
    ...(session.runtimeContext != null
      ? { runtimeContext: recordValue(session.runtimeContext) }
      : {}),
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
    occurredAtUnixMs: normalizedTuttidMessageOccurredAtUnixMs(message),
    payload: recordValue(message.payload),
    role: message.role,
    ...(message.semantics != null ? { semantics: message.semantics } : {}),
    startedAtUnixMs: message.startedAtUnixMs ?? undefined,
    status: message.status ?? undefined,
    turnId: normalizedTuttidMessageTurnId(message),
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

export function agentActivityComposerOptionsFromTuttidResult(
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
  // The live agent's advertised model list reflects what the running session
  // can actually use, so it takes precedence when present.
  const modelsFromLiveConfig = settingOptionsFromConfigOption(
    rawConfigOptions,
    ["model"]
  );
  const reasoningEffortsFromConfig =
    settingOptionsFromComposerConfig(reasoningConfig);
  const reasoningEffortsFromLiveConfig = settingOptionsFromConfigOption(
    rawConfigOptions,
    ["reasoning_effort", "model_reasoning_effort", "effort"]
  );
  const speedsFromConfig = settingOptionsFromComposerConfig(speedConfig);
  const speedsFromLiveConfig = settingOptionsFromConfigOption(
    rawConfigOptions,
    ["service_tier", "speed", "fast"]
  );
  const skillsFromResult = skillOptionsFromValue(result.skills);
  const skillsFromRuntimeContext = skillOptionsFromValue(runtimeContext.skills);
  const capabilitiesFromResult = capabilityOptionsFromValue(
    result.capabilityCatalog
  );
  const capabilitiesFromRuntimeContext = capabilityOptionsFromValue(
    runtimeContext.capabilityCatalog
  );
  const capabilityCatalog =
    capabilitiesFromResult.length > 0
      ? capabilitiesFromResult
      : capabilitiesFromRuntimeContext;
  return {
    provider: normalizeText(result.provider) ?? provider,
    models:
      modelsFromLiveConfig.length > 0 ? modelsFromLiveConfig : modelsFromConfig,
    reasoningEfforts:
      reasoningEffortsFromConfig.length > 0
        ? reasoningEffortsFromConfig
        : reasoningEffortsFromLiveConfig,
    speeds:
      speedsFromConfig.length > 0 ? speedsFromConfig : speedsFromLiveConfig,
    modelConfigurable:
      modelConfig.configurable === true ||
      (modelConfig.configurable === undefined &&
        modelsFromLiveConfig.length > 0),
    reasoningConfigurable:
      reasoningConfig.configurable === true ||
      (reasoningConfig.configurable === undefined &&
        reasoningEffortsFromLiveConfig.length > 0),
    speedConfigurable:
      speedConfig.configurable === true ||
      (speedConfig.configurable === undefined &&
        speedsFromLiveConfig.length > 0),
    permissionConfig: permissionConfigFromValue(result.permissionConfig),
    runtimeContext,
    skills:
      skillsFromResult.length > 0 ? skillsFromResult : skillsFromRuntimeContext,
    capabilityCatalog,
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
  const options: AgentActivityComposerSettingOption[] = [];
  const seen = new Set<string>();
  for (const item of flattenRawSettingOptions(value)) {
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

function flattenRawSettingOptions(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const flattened: unknown[] = [];
  for (const item of value as unknown[]) {
    const record = recordValue(item);
    if (Array.isArray(record.options)) {
      flattened.push(...flattenRawSettingOptions(record.options));
    } else {
      flattened.push(item);
    }
  }
  return flattened;
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
    const path = normalizeText(record.path);
    const kind = normalizeSkillKind(record.kind);
    options.push({
      name,
      trigger,
      sourceKind,
      ...(description ? { description } : {}),
      ...(pluginName ? { pluginName } : {}),
      ...(path ? { path } : {}),
      ...(kind ? { kind } : {})
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
    case "connector":
      return normalized;
    default:
      return null;
  }
}

function normalizeSkillKind(
  value: unknown
): AgentActivityComposerSkillOption["kind"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "skill":
    case "connector":
      return normalized;
    default:
      return null;
  }
}

function capabilityOptionsFromValue(
  value: unknown
): AgentActivityComposerCapabilityOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: AgentActivityComposerCapabilityOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = recordValue(item);
    const id = normalizeText(record.id);
    const kind = normalizeCapabilityKind(record.kind);
    const name = normalizeText(record.name);
    const label = normalizeText(record.label) ?? name;
    const status = normalizeCapabilityStatus(record.status);
    const invocation = normalizeCapabilityInvocation(record.invocation);
    if (
      !id ||
      !kind ||
      !name ||
      !label ||
      !status ||
      !invocation ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    const description = normalizeText(record.description);
    const source = normalizeText(record.source);
    const pluginName = normalizeText(record.pluginName);
    const serverName = normalizeText(record.serverName);
    const toolName = normalizeText(record.toolName);
    const trigger = normalizeText(record.trigger);
    const path = normalizeText(record.path);
    options.push({
      id,
      kind,
      name,
      label,
      status,
      invocation,
      ...(description ? { description } : {}),
      ...(source ? { source } : {}),
      ...(pluginName ? { pluginName } : {}),
      ...(serverName ? { serverName } : {}),
      ...(toolName ? { toolName } : {}),
      ...(trigger ? { trigger } : {}),
      ...(path ? { path } : {})
    });
  }
  return options;
}

function normalizeCapabilityKind(
  value: unknown
): AgentActivityComposerCapabilityOption["kind"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "skill":
    case "plugin":
    case "connector":
    case "mcpServer":
    case "mcpTool":
      return normalized;
    default:
      return null;
  }
}

function normalizeCapabilityStatus(
  value: unknown
): AgentActivityComposerCapabilityOption["status"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "available":
    case "disabled":
    case "authRequired":
    case "setupRequired":
    case "unsupported":
      return normalized;
    default:
      return null;
  }
}

function normalizeCapabilityInvocation(
  value: unknown
): AgentActivityComposerCapabilityOption["invocation"] | null {
  const normalized = normalizeText(value);
  switch (normalized) {
    case "promptItem":
    case "textTrigger":
    case "none":
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

function withAbortableRequestTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: {
    signal?: AbortSignal;
    timeoutMessage: string;
    timeoutMs: number;
  }
): Promise<T> {
  const controller = new AbortController();
  const racers: Array<Promise<T>> = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let abortListener: (() => void) | null = null;

  if (options.signal) {
    if (options.signal.aborted) {
      const error = abortSignalError(options.signal);
      controller.abort(error);
      return Promise.reject(error);
    }
    racers.push(
      new Promise<never>((_, reject) => {
        abortListener = () => {
          const error = abortSignalError(options.signal);
          controller.abort(error);
          reject(error);
        };
        options.signal?.addEventListener("abort", abortListener, {
          once: true
        });
      })
    );
  }

  racers.push(request(controller.signal));

  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    racers.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = Object.assign(new Error(options.timeoutMessage), {
            code: "ETIMEDOUT"
          });
          controller.abort(error);
          reject(error);
        }, options.timeoutMs);
      })
    );
  }

  return Promise.race(racers).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
  });
}

function abortSignalError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("Agent composer options request was cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function workspaceAgentProvider(value: string): WorkspaceAgentProvider {
  return value as WorkspaceAgentProvider;
}
