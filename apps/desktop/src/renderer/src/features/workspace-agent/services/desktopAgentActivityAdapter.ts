import type {
  AgentActivityAdapter,
  AgentActivityMessage,
  AgentActivityProviderTargetRef,
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
import { agentActivityComposerOptionsFromTuttidResult } from "../../../lib/agentComposerOptionsProjection.ts";

export interface CreateDesktopAgentActivityAdapterInput {
  agentProviderStatusService?: Pick<IAgentProviderStatusService, "refresh">;
  agentSessionCreateRequestTimeoutMs?: number;
  composerOptionsRequestTimeoutMs?: number;
  tuttidClient: TuttidClient;
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
}

const defaultAgentSessionCreateRequestTimeoutMs = 30_000;
const defaultComposerOptionsRequestTimeoutMs = 15_000;
const agentActivitySessionListLimit = 100;

export function createDesktopAgentActivityAdapter({
  agentProviderStatusService,
  agentSessionCreateRequestTimeoutMs = defaultAgentSessionCreateRequestTimeoutMs,
  composerOptionsRequestTimeoutMs = defaultComposerOptionsRequestTimeoutMs,
  tuttidClient,
  runtimeApi
}: CreateDesktopAgentActivityAdapterInput): AgentActivityAdapter {
  // At most one pre-warm draft per workspace target. Switching plan/permission/model
  // updates this draft in place via the ACP protocol instead of tearing it
  // down and creating a brand new hidden session on every toggle.
  const claudeDrafts = new Map<string, ClaudeDraftSessionEntry>();

  const deleteClaudeDraft = (entry: ClaudeDraftSessionEntry): void => {
    if (entry.status === "promoted") {
      return;
    }
    entry.status = "disposed";
    if (claudeDrafts.get(entry.cacheKey) === entry) {
      claudeDrafts.delete(entry.cacheKey);
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
    const agentTargetId = requiredAgentTargetId(input.agentTargetId);
    const promise = withAbortableRequestTimeout(
      (signal) => {
        const runtimeContext = createSessionRuntimeContext({ cwd });
        return tuttidClient.createWorkspaceAgentSession(
          input.workspaceId,
          {
            agentSessionId,
            agentTargetId,
            cwd,
            initialContent: [],
            model: input.settings.model,
            permissionModeId: input.settings.permissionModeId,
            planMode: input.settings.planMode,
            provider: "claude-code",
            reasoningEffort: input.settings.reasoningEffort,
            ...(runtimeContext ? { runtimeContext } : {}),
            speed: input.settings.speed,
            title: null,
            visible: false
          },
          { signal }
        );
      },
      {
        signal: input.signal,
        timeoutMessage: "Agent session create request timed out.",
        timeoutMs: agentSessionCreateRequestTimeoutMs
      }
    ).then((session) => sessionWithClaudeDraftContext(session, draftKey));
    const entry: ClaudeDraftSessionEntry = {
      cacheKey: claudeDraftCacheKey(input),
      cwd,
      promise,
      providerTargetKey: claudeDraftTargetKey(input),
      sessionId: agentSessionId,
      settingsKey,
      status: "starting",
      workspaceId: input.workspaceId
    };
    claudeDrafts.set(entry.cacheKey, entry);
    void promise.then(
      (session) => {
        if (entry.status === "starting") {
          entry.status = "ready";
          entry.sessionId = session.id;
        }
      },
      () => {
        entry.status = "failed";
        if (claudeDrafts.get(entry.cacheKey) === entry) {
          claudeDrafts.delete(entry.cacheKey);
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
    const providerTargetKey = claudeDraftTargetKey(input);
    const existing = claudeDrafts.get(claudeDraftCacheKey(input));
    if (
      existing &&
      existing.status !== "disposed" &&
      existing.status !== "failed" &&
      existing.cwd === cwd &&
      existing.providerTargetKey === providerTargetKey &&
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
    const requestedAgentSessionId = normalizeText(input.agentSessionId);
    const existingSameRequestedSession = requestedAgentSessionId
      ? Array.from(claudeDrafts.values()).find(
          (entry) =>
            entry.workspaceId === input.workspaceId &&
            entry.sessionId === requestedAgentSessionId &&
            entry.providerTargetKey !== providerTargetKey &&
            !isDeadDraftStatus(entry.status)
        )
      : undefined;
    const shouldCreateFreshDraftSession =
      (existing &&
        existing.providerTargetKey !== providerTargetKey &&
        requestedAgentSessionId === existing.sessionId) ||
      existingSameRequestedSession !== undefined;
    if (existing) {
      deleteClaudeDraft(existing);
    }
    if (
      existingSameRequestedSession &&
      existingSameRequestedSession !== existing
    ) {
      deleteClaudeDraft(existingSameRequestedSession);
    }
    return createClaudeDraft(
      shouldCreateFreshDraftSession
        ? { ...input, agentSessionId: null }
        : input,
      cwd,
      settingsKey
    );
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
    const entry = claudeDrafts.get(claudeDraftCacheKey(input));
    if (
      !entry ||
      entry.sessionId !== agentSessionId ||
      entry.providerTargetKey !== claudeDraftTargetKey(input) ||
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
    if (claudeDrafts.get(entry.cacheKey) === entry) {
      claudeDrafts.delete(entry.cacheKey);
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
        input.workspaceId,
        { limit: agentActivitySessionListLimit }
      );
      return {
        sessions: response.sessions.map((session) =>
          agentActivitySessionFromTuttidSession(input.workspaceId, session)
        )
      };
    },
    async listSessionMessages(input) {
      const startedAt = Date.now();
      reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
        afterVersion: input.afterVersion ?? 0,
        agentSessionId: input.agentSessionId,
        beforeVersion: input.beforeVersion ?? null,
        event: "requested",
        limit: input.limit ?? null,
        order: input.order ?? null
      });
      try {
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
        const messages = response.messages.map((message) =>
          agentActivityMessageFromTuttidMessage(input.workspaceId, message)
        );
        const versions = messages
          .map((message) => message.version)
          .filter((version) => Number.isFinite(version));
        reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
          agentSessionId: input.agentSessionId,
          durationMs: Date.now() - startedAt,
          event: "resolved",
          firstVersion: versions.length ? Math.min(...versions) : null,
          hasMore: response.hasMore,
          lastVersion: versions.length ? Math.max(...versions) : null,
          latestVersion: response.latestVersion,
          messageCount: messages.length
        });
        return {
          hasMore: response.hasMore,
          latestVersion: response.latestVersion,
          messages
        };
      } catch (error) {
        reportDesktopAgentMessageListDiagnostic(runtimeApi, input.workspaceId, {
          agentSessionId: input.agentSessionId,
          durationMs: Date.now() - startedAt,
          event: "failed",
          ...normalizeDesktopAgentDiagnosticError(error)
        });
        throw error;
      }
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
            agentTargetId: input.agentTargetId ?? null,
            cwd: input.cwd ?? null,
            settings: normalizedClaudeDraftSettings({
              model: input.model,
              permissionModeId: input.permissionModeId,
              planMode: input.planMode,
              reasoningEffort: input.reasoningEffort,
              speed: input.speed
            }),
            providerTargetRef: input.providerTargetRef ?? null,
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
        const agentTargetId = requiredAgentTargetId(input.agentTargetId);
        const session = await withAbortableRequestTimeout(
          (signal) => {
            const runtimeContext = createSessionRuntimeContext(input);
            return tuttidClient.createWorkspaceAgentSession(
              input.workspaceId,
              {
                agentSessionId,
                agentTargetId,
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
                ...(runtimeContext ? { runtimeContext } : {}),
                speed: input.speed ?? null,
                title: input.title ?? null,
                visible: input.visible ?? null
              },
              { signal }
            );
          },
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
          ...(input.guidance === true ? { guidance: true } : {}),
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
    async goalControl(input) {
      const result = await tuttidClient.goalControlWorkspaceAgentSession(
        input.workspaceId,
        input.agentSessionId,
        {
          action: input.action,
          ...(input.objective !== undefined
            ? { objective: input.objective }
            : {})
        }
      );
      return {
        goal: result.goal ?? null,
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

function reportDesktopAgentMessageListDiagnostic(
  runtimeApi: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">,
  workspaceId: string,
  details: Record<string, string | number | boolean | null>
): void {
  try {
    void runtimeApi
      .logTerminalDiagnostic({
        details,
        event: "agent.activity.messages.list",
        level: details.event === "failed" ? "warn" : "info",
        workspaceId
      })
      .catch(() => {});
  } catch {
    // Diagnostic logging must not affect message loading.
  }
}

function normalizeDesktopAgentDiagnosticError(
  error: unknown
): Record<string, string | number | boolean | null> {
  if (!(error instanceof Error)) {
    return { errorName: typeof error };
  }
  const record = error as Error & {
    code?: unknown;
    reason?: unknown;
    retryable?: unknown;
    statusCode?: unknown;
  };
  return {
    ...(typeof record.code === "string" ? { errorCode: record.code } : {}),
    errorMessageLength: error.message.length,
    errorName: error.name,
    ...(typeof record.reason === "string"
      ? { errorReason: record.reason }
      : {}),
    ...(typeof record.retryable === "boolean"
      ? { errorRetryable: record.retryable }
      : {}),
    ...(typeof record.statusCode === "number"
      ? { errorStatusCode: record.statusCode }
      : {})
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
  agentTargetId?: string | null;
  cwd: string | null;
  providerTargetRef?: AgentActivityProviderTargetRef | null;
  settings: ClaudeDraftSettings;
  signal?: AbortSignal;
  workspaceId: string;
}

interface ClaudeDraftSessionEntry {
  cacheKey: string;
  cwd: string | null;
  providerTargetKey: string;
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
    agentTargetId: normalizeText(input.agentTargetId) ?? "",
    cwd: input.cwd ?? "",
    providerTargetRef: sortProviderTargetRefValue(input.providerTargetRef),
    settings: input.settings,
    workspaceId: input.workspaceId
  });
}

function claudeDraftCacheKey(
  input: Pick<
    ClaudeDraftInput,
    "agentTargetId" | "providerTargetRef" | "workspaceId"
  >
): string {
  return `${input.workspaceId}:${claudeDraftTargetKey(input)}`;
}

function claudeDraftTargetKey(
  input: Pick<ClaudeDraftInput, "agentTargetId" | "providerTargetRef">
): string {
  const agentTargetId = normalizeText(input.agentTargetId);
  if (agentTargetId) {
    return `agentTarget:${agentTargetId}`;
  }
  return `providerTarget:${providerTargetRefKey(input.providerTargetRef)}`;
}

function requiredAgentTargetId(value: string | null | undefined): string {
  const agentTargetId = normalizeText(value);
  if (!agentTargetId) {
    throw new Error("Agent target id is required to create an agent session.");
  }
  return agentTargetId;
}

function createSessionRuntimeContext(input: {
  cwd?: string | null;
  runtimeContext?: Record<string, unknown> | null;
}): Record<string, unknown> | undefined {
  const runtimeContext = { ...(input.runtimeContext ?? {}) };
  if (!normalizeText(input.cwd)) {
    runtimeContext.noProject = true;
  }
  return Object.keys(runtimeContext).length > 0 ? runtimeContext : undefined;
}

function providerTargetRefKey(
  value: AgentActivityProviderTargetRef | null | undefined
): string {
  return JSON.stringify(sortProviderTargetRefValue(value ?? null));
}

function sortProviderTargetRefValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortProviderTargetRefValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortProviderTargetRefValue(entryValue)])
  );
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
    ...(session.agentTargetId ? { agentTargetId: session.agentTargetId } : {}),
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? session.id,
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
