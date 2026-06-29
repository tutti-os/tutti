import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import type {
  AgentActivityMessage,
  AgentActivityMessagePage,
  AgentActivitySession,
  AgentActivitySessionEventEnvelope,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { AgentConversationPinnedReporter } from "../../analytics/reporters/agent-conversation-pinned/agentConversationPinnedReporter.ts";
import { AgentConversationUnpinnedReporter } from "../../analytics/reporters/agent-conversation-unpinned/agentConversationUnpinnedReporter.ts";
import { AgentSettingsProjectChangedReporter } from "../../analytics/reporters/agent-settings-project-changed/agentSettingsProjectChangedReporter.ts";
import {
  createAgentMessageSentTracker,
  createOptionalReporterService
} from "./internal/agentMessageSentAnalytics.ts";
import { createAgentMessageStoppedTracker } from "./internal/agentMessageStoppedAnalytics.ts";
import {
  createAgentSessionStartedTracker,
  resolveAgentSessionSource
} from "./internal/agentSessionStartedAnalytics.ts";
import {
  resolveComposerPermissionMode,
  resolveDesktopAgentGUIProvider,
  type AgentHostAgentSessionComposerSettings
} from "./internal/desktopAgentHostProjection.ts";
import { reportAgentSessionSettingsChanges } from "./internal/agentSessionSettingsAnalytics.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";

type AgentComposerSettingsChange = {
  field: "model" | "permissionModeId" | "planMode" | "reasoningEffort";
  from: boolean | string | null;
  to: boolean | string | null;
};

interface CreateDesktopAgentActivityRuntimeOptions {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  runtimeApi?: Pick<
    DesktopRuntimeApi,
    "logRendererDiagnostic" | "logTerminalDiagnostic"
  >;
  warmupOpenclawGateway?: AgentActivityRuntime["warmupOpenclawGateway"];
  workspaceUserProjectService?: Pick<
    IWorkspaceUserProjectService,
    "isNoProjectPath"
  >;
}

export function createDesktopAgentActivityRuntime(
  workspaceAgentActivityService: IWorkspaceAgentActivityService,
  options: CreateDesktopAgentActivityRuntimeOptions = {}
): AgentActivityRuntime {
  const runtimeSnapshotDiagnosticSignatures = new Map<string, string>();
  const runtimeMessagePageDiagnosticSignatures = new Map<string, string>();
  const reportRuntimeDiagnostic = (input: {
    details?: Record<string, unknown>;
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    workspaceId?: string | null;
  }): void => {
    try {
      void options.runtimeApi
        ?.logRendererDiagnostic({
          details: input.details ?? {},
          event: input.event,
          level: input.level ?? "info",
          source: "agent-gui",
          workspaceId: input.workspaceId ?? undefined
        })
        .catch(() => {});
    } catch {
      // Diagnostic logging must never affect the render tree.
    }
  };
  const reportSnapshotDiagnostic = (
    workspaceId: string,
    snapshot: AgentActivitySnapshot,
    source: "get_snapshot" | "load" | "subscribe"
  ): void => {
    const signature = agentActivitySnapshotDiagnosticSignature(snapshot);
    const key = `${workspaceId}:${source}`;
    if (runtimeSnapshotDiagnosticSignatures.get(key) === signature) {
      return;
    }
    runtimeSnapshotDiagnosticSignatures.set(key, signature);
    reportRuntimeDiagnostic({
      details: {
        source,
        ...agentActivitySnapshotDiagnosticDetails(snapshot)
      },
      event: "agent.gui.runtime.snapshot_changed",
      level: source === "get_snapshot" ? "debug" : "info",
      workspaceId
    });
  };
  const reportMessagePageDiagnostic = (
    input: Parameters<AgentActivityRuntime["listSessionMessages"]>[0],
    page: AgentActivityMessagePage
  ): void => {
    const signature = agentActivityMessagePageDiagnosticSignature(page);
    const key = `${input.workspaceId}:${input.agentSessionId}:${input.afterVersion ?? ""}:${input.beforeVersion ?? ""}:${input.order ?? ""}:${input.limit ?? ""}`;
    if (runtimeMessagePageDiagnosticSignatures.get(key) === signature) {
      return;
    }
    runtimeMessagePageDiagnosticSignatures.set(key, signature);
    reportRuntimeDiagnostic({
      details: {
        afterVersion: input.afterVersion ?? null,
        agentSessionId: input.agentSessionId,
        beforeVersion: input.beforeVersion ?? null,
        cache: input.cache ?? null,
        hasMore: page.hasMore,
        lastMessage: agentActivityMessageDiagnosticDetails(
          page.messages.at(-1) ?? null
        ),
        latestVersion: page.latestVersion,
        messageCount: page.messages.length,
        order: input.order ?? null
      },
      event: "agent.gui.runtime.messages.resolved",
      level: "info",
      workspaceId: input.workspaceId
    });
  };
  const messageSentTracker = createAgentMessageSentTracker({
    reporterNow: options.reporterNow,
    reporterService: options.reporterService
  });
  const messageStoppedTracker = createAgentMessageStoppedTracker({
    reporterNow: options.reporterNow,
    reporterService: options.reporterService
  });
  const sessionStartedTracker = createAgentSessionStartedTracker({
    reporterNow: options.reporterNow,
    reporterService: options.reporterService
  });
  return {
    async activateSession(input) {
      reportAgentSubmitTraceDiagnostic({
        agentSessionId: input.agentSessionId,
        event: "activity_runtime.activate.entered",
        metadata: input.metadata,
        runtimeApi: options.runtimeApi,
        workspaceId: input.workspaceId,
        fields: {
          mode: input.mode,
          provider: resolveDesktopAgentGUIProvider(input.provider)
        }
      });
      const activation =
        await workspaceAgentActivityService.activateSession(input);
      reportAgentSubmitTraceDiagnostic({
        agentSessionId: activation.session.agentSessionId,
        event: "activity_runtime.activate.resolved",
        metadata: input.metadata,
        runtimeApi: options.runtimeApi,
        workspaceId: input.workspaceId,
        fields: {
          mode: input.mode,
          provider: activation.session.provider,
          sessionStatus: activation.session.status
        }
      });
      const activationFailed = activation.activation.status === "failed";
      if (input.mode === "new" && !activationFailed) {
        await sessionStartedTracker.track({
          agentSessionId: activation.session.agentSessionId,
          hasProject:
            Boolean(activation.session.cwd?.trim()) &&
            !(
              activation.session.cwd &&
              options.workspaceUserProjectService?.isNoProjectPath(
                activation.session.cwd
              )
            ),
          model: input.settings?.model,
          permissionMode: resolveComposerPermissionMode(input.settings),
          provider: activation.session.provider,
          source: resolveAgentSessionSource({ mode: input.mode })
        });
      }
      return activation;
    },
    async cancelSession(input) {
      const result = await workspaceAgentActivityService.cancelSession(input);
      if (result.canceled) {
        await messageStoppedTracker.track({
          agentSessionId: result.session.agentSessionId,
          provider: result.session.provider
        });
      }
      return result;
    },
    createSession: (input) =>
      workspaceAgentActivityService.createSession(input),
    deleteSession: (input) =>
      workspaceAgentActivityService.deleteSession(input),
    getComposerOptions: (input) =>
      workspaceAgentActivityService.getComposerOptions(input),
    getSession: (workspaceId, agentSessionId) =>
      workspaceAgentActivityService.getSession(workspaceId, agentSessionId),
    getSessionControlState: (input) =>
      workspaceAgentActivityService.getSessionControlState(input),
    getSnapshot(workspaceId) {
      const snapshot = workspaceAgentActivityService.getSnapshot(workspaceId);
      reportSnapshotDiagnostic(workspaceId, snapshot, "get_snapshot");
      return snapshot;
    },
    async listSessionMessages(input) {
      const page =
        await workspaceAgentActivityService.listSessionMessages(input);
      reportMessagePageDiagnostic(input, page);
      return page;
    },
    listAgentGeneratedFiles: (input) =>
      workspaceAgentActivityService.listAgentGeneratedFiles(input),
    async load(workspaceId, signal) {
      const snapshot = await workspaceAgentActivityService.load(
        workspaceId,
        signal
      );
      reportSnapshotDiagnostic(workspaceId, snapshot, "load");
      return snapshot;
    },
    ensureSessionSynchronized(input) {
      reportRuntimeDiagnostic({
        details: {
          afterVersion: input.afterVersion ?? null,
          agentSessionId: input.agentSessionId
        },
        event: "agent.gui.runtime.ensure_session_synchronized",
        level: "debug",
        workspaceId: input.workspaceId
      });
      return workspaceAgentActivityService.ensureSessionSynchronized(input);
    },
    retainSessionEvents: (input) =>
      workspaceAgentActivityService.retainSessionEvents(input),
    async sendInput(input) {
      reportAgentSubmitTraceDiagnostic({
        agentSessionId: input.agentSessionId,
        event: "activity_runtime.send.entered",
        metadata: input.metadata,
        runtimeApi: options.runtimeApi,
        workspaceId: input.workspaceId
      });
      const result = await workspaceAgentActivityService.sendInput(input);
      reportAgentSubmitTraceDiagnostic({
        agentSessionId: result.session.agentSessionId,
        event: "activity_runtime.send.resolved",
        metadata: input.metadata,
        runtimeApi: options.runtimeApi,
        workspaceId: input.workspaceId,
        fields: {
          provider: result.session.provider,
          sessionStatus: result.session.status,
          turnId: result.turnId,
          turnPhase: result.turnLifecycle?.phase ?? null
        }
      });
      await messageSentTracker.track({
        agentSessionId: result.session.agentSessionId,
        prompt: promptContentDisplayText(input.content),
        provider: result.session.provider
      });
      return result;
    },
    readSessionAttachment: (input) =>
      workspaceAgentActivityService.readSessionAttachment(input),
    async setSessionPinned(input) {
      const session =
        await workspaceAgentActivityService.setSessionPinned(input);
      const reporter = input.pinned
        ? AgentConversationPinnedReporter
        : AgentConversationUnpinnedReporter;
      await new reporter(
        {
          agentSessionId: session.agentSessionId,
          provider: session.provider
        },
        {
          reporterService: createOptionalReporterService(
            options.reporterService
          ),
          now: options.reporterNow
        }
      ).report();
      return session;
    },
    async updateSessionSettings(input) {
      const previousState =
        await workspaceAgentActivityService.getSessionControlState({
          workspaceId: input.workspaceId,
          agentSessionId: input.agentSessionId
        });
      let result: Awaited<
        ReturnType<IWorkspaceAgentActivityService["updateSessionSettings"]>
      >;
      try {
        result =
          await workspaceAgentActivityService.updateSessionSettings(input);
      } catch (error) {
        logAgentComposerSettingsDiagnostic({
          agentSessionId: input.agentSessionId,
          error,
          event: "agent.gui.composer_settings.update_failed",
          nextSettings: input.settings,
          previousSettings: previousState.settings,
          provider: previousState.provider,
          runtimeApi: options.runtimeApi,
          source: "session",
          workspaceId: input.workspaceId
        });
        throw error;
      }
      await reportAgentSessionSettingsChanges({
        agentSessionId: result.agentSessionId,
        nextSettings: result.settings,
        previousSettings: previousState.settings,
        provider: previousState.provider,
        reporterNow: options.reporterNow,
        reporterService: options.reporterService
      });
      logAgentComposerSettingsDiagnostic({
        agentSessionId: result.agentSessionId,
        event: "agent.gui.composer_settings.changed",
        nextSettings: result.settings,
        previousSettings: previousState.settings,
        provider: previousState.provider,
        runtimeApi: options.runtimeApi,
        source: "session",
        workspaceId: input.workspaceId
      });
      return result;
    },
    async trackSettingsProjectChange(input) {
      await new AgentSettingsProjectChangedReporter(
        {
          action: input.action,
          agentSessionId: input.agentSessionId,
          provider: resolveDesktopAgentGUIProvider(input.provider)
        },
        {
          reporterService: createOptionalReporterService(
            options.reporterService
          ),
          now: options.reporterNow
        }
      ).report();
    },
    async trackDraftComposerSettingsChange(input) {
      await reportAgentSessionSettingsChanges({
        agentSessionId: null,
        nextSettings: input.nextSettings,
        previousSettings: input.previousSettings,
        provider: input.provider,
        reporterNow: options.reporterNow,
        reporterService: options.reporterService
      });
      logAgentComposerSettingsDiagnostic({
        agentSessionId: null,
        event: "agent.gui.composer_settings.changed",
        nextSettings: input.nextSettings,
        previousSettings: input.previousSettings,
        provider: input.provider,
        runtimeApi: options.runtimeApi,
        source: "draft",
        workspaceId: input.workspaceId
      });
    },
    reportDiagnostic(input) {
      reportRuntimeDiagnostic({
        details: input.details,
        event: input.event,
        level: input.level,
        workspaceId: input.workspaceId
      });
    },
    ...(options.warmupOpenclawGateway
      ? {
          warmupOpenclawGateway: options.warmupOpenclawGateway
        }
      : {}),
    subscribeSessionEvents: (workspaceId, listener) =>
      workspaceAgentActivityService.onSessionEvent(workspaceId, (event) => {
        reportSessionEventDiagnostic(
          workspaceId,
          event,
          reportRuntimeDiagnostic
        );
        listener(event);
      }),
    unactivateSession: (input) =>
      workspaceAgentActivityService.unactivateSession(input),
    submitInteractive: (input) =>
      workspaceAgentActivityService.submitInteractive(input),
    subscribe: (workspaceId, listener) =>
      workspaceAgentActivityService.subscribe(workspaceId, (snapshot) => {
        reportSnapshotDiagnostic(workspaceId, snapshot, "subscribe");
        listener(snapshot);
      })
  };
}

function agentActivitySnapshotDiagnosticSignature(
  snapshot: AgentActivitySnapshot
): string {
  return snapshot.sessions
    .map((session) => agentActivitySessionDiagnosticSignature(session))
    .sort()
    .join("|");
}

function agentActivitySnapshotDiagnosticDetails(
  snapshot: AgentActivitySnapshot
): Record<string, unknown> {
  const sessions = [...snapshot.sessions].sort(
    (left, right) =>
      agentActivitySessionSortTimeUnixMs(right) -
      agentActivitySessionSortTimeUnixMs(left)
  );
  const activeOrRecentSessions = sessions
    .filter(
      (session, index) => index < 8 || agentActivitySessionIsBusy(session)
    )
    .slice(0, 12)
    .map((session) => agentActivitySessionDiagnosticDetails(session));
  return {
    activeOrRecentSessions,
    busySessionCount: snapshot.sessions.filter(agentActivitySessionIsBusy)
      .length,
    presenceCount: snapshot.presences.length,
    sessionCount: snapshot.sessions.length,
    workspaceId: snapshot.workspaceId
  };
}

function agentActivitySessionDiagnosticSignature(
  session: AgentActivitySession
): string {
  const lifecycle = session.turnLifecycle;
  const submitAvailability = session.submitAvailability;
  return [
    session.agentSessionId,
    session.provider,
    session.status,
    session.currentPhase ?? "",
    lifecycle?.activeTurnId ?? "",
    lifecycle?.phase ?? "",
    lifecycle?.outcome ?? "",
    submitAvailability?.state ?? "",
    submitAvailability?.reason ?? "",
    session.messageVersion ?? "",
    session.lastEventUnixMs ?? "",
    session.updatedAtUnixMs ?? ""
  ].join(":");
}

function agentActivitySessionDiagnosticDetails(
  session: AgentActivitySession
): Record<string, unknown> {
  const lifecycle = session.turnLifecycle;
  const submitAvailability = session.submitAvailability;
  return {
    activeTurnId: lifecycle?.activeTurnId ?? null,
    agentSessionId: session.agentSessionId,
    currentPhase: session.currentPhase ?? null,
    lastEventUnixMs: session.lastEventUnixMs ?? null,
    messageVersion: session.messageVersion ?? null,
    outcome: lifecycle?.outcome ?? null,
    provider: session.provider,
    status: session.status,
    submitAvailabilityReason: submitAvailability?.reason ?? null,
    submitAvailabilityState: submitAvailability?.state ?? null,
    turnPhase: lifecycle?.phase ?? null,
    updatedAtUnixMs: session.updatedAtUnixMs ?? null
  };
}

function agentActivitySessionIsBusy(session: AgentActivitySession): boolean {
  const status = session.status;
  const phase = session.turnLifecycle?.phase;
  const submitState = session.submitAvailability?.state;
  return (
    status === "queued" ||
    status === "working" ||
    status === "waiting" ||
    phase === "working" ||
    phase === "waiting" ||
    submitState === "blocked"
  );
}

function agentActivitySessionSortTimeUnixMs(
  session: AgentActivitySession
): number {
  return (
    session.lastEventUnixMs ??
    session.updatedAtUnixMs ??
    session.createdAtUnixMs ??
    session.startedAtUnixMs ??
    0
  );
}

function agentActivityMessagePageDiagnosticSignature(
  page: AgentActivityMessagePage
): string {
  return [
    page.latestVersion,
    page.hasMore ? "1" : "0",
    page.messages.length,
    page.messages.at(0)?.version ?? "",
    page.messages.at(-1)?.version ?? "",
    page.messages.at(-1)?.kind ?? "",
    page.messages.at(-1)?.status ?? ""
  ].join(":");
}

function agentActivityMessageDiagnosticDetails(
  message: AgentActivityMessage | null
): Record<string, unknown> | null {
  if (!message) {
    return null;
  }
  return {
    agentSessionId: message.agentSessionId,
    kind: message.kind,
    messageId: message.messageId,
    role: message.role,
    status: message.status ?? null,
    turnId: message.turnId,
    version: message.version
  };
}

function reportSessionEventDiagnostic(
  workspaceId: string,
  event: unknown,
  reportRuntimeDiagnostic: (input: {
    details?: Record<string, unknown>;
    event: string;
    level?: "debug" | "info" | "warn" | "error";
    workspaceId?: string | null;
  }) => void
): void {
  const envelope = isAgentActivitySessionEventEnvelope(event) ? event : null;
  reportRuntimeDiagnostic({
    details: envelope
      ? {
          agentSessionId: envelope.agentSessionId,
          data: agentActivitySessionEventDataDiagnosticDetails(envelope.data),
          eventType: envelope.eventType
        }
      : {
          eventType: "unknown"
        },
    event: "agent.gui.runtime.session_event_received",
    level: "debug",
    workspaceId
  });
}

function isAgentActivitySessionEventEnvelope(
  value: unknown
): value is AgentActivitySessionEventEnvelope {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { agentSessionId?: unknown }).agentSessionId ===
      "string" &&
    typeof (value as { eventType?: unknown }).eventType === "string"
  );
}

function agentActivitySessionEventDataDiagnosticDetails(
  data: unknown
): Record<string, unknown> | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  return {
    kind: typeof record.kind === "string" ? record.kind : null,
    messageId: typeof record.messageId === "string" ? record.messageId : null,
    role: typeof record.role === "string" ? record.role : null,
    status: typeof record.status === "string" ? record.status : null,
    turnId: typeof record.turnId === "string" ? record.turnId : null,
    version:
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : null
  };
}

function reportAgentSubmitTraceDiagnostic(input: {
  agentSessionId: string | null;
  event: string;
  metadata: Record<string, unknown> | undefined;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  workspaceId: string;
  fields?: Record<string, unknown>;
}): void {
  if (!input.runtimeApi) {
    return;
  }
  const clientSubmitId = stringMetadata(input.metadata, "clientSubmitId");
  if (!clientSubmitId) {
    return;
  }
  const submittedAtUnixMs = numberMetadata(
    input.metadata,
    "clientSubmittedAtUnixMs"
  );
  try {
    void input.runtimeApi
      .logTerminalDiagnostic({
        details: {
          agentSessionId: input.agentSessionId,
          clientSubmitId,
          clientSubmittedAtUnixMs: submittedAtUnixMs,
          elapsedSinceClientSubmitMs:
            submittedAtUnixMs > 0
              ? Math.max(0, Date.now() - submittedAtUnixMs)
              : null,
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

function promptContentDisplayText(
  content: readonly { type: string; text?: string }[]
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function logAgentComposerSettingsDiagnostic(input: {
  agentSessionId: string | null;
  error?: unknown;
  event:
    | "agent.gui.composer_settings.changed"
    | "agent.gui.composer_settings.update_failed";
  nextSettings: AgentHostAgentSessionComposerSettings;
  previousSettings: AgentHostAgentSessionComposerSettings | undefined;
  provider: string;
  runtimeApi?: Pick<DesktopRuntimeApi, "logTerminalDiagnostic">;
  source: "draft" | "session";
  workspaceId: string;
}): void {
  if (!input.runtimeApi) {
    return;
  }
  const changes = agentComposerSettingsChanges(
    input.previousSettings,
    input.nextSettings
  );
  if (
    changes.length === 0 &&
    input.event === "agent.gui.composer_settings.changed"
  ) {
    return;
  }
  void input.runtimeApi.logTerminalDiagnostic({
    details: {
      agentSessionId: input.agentSessionId,
      changedFields: changes.map((change) => change.field).join(","),
      ...(input.error ? { error: stringifyDiagnosticError(input.error) } : {}),
      ...flattenAgentComposerSettingsChanges(changes),
      provider: resolveDesktopAgentGUIProvider(input.provider),
      source: input.source
    },
    event: input.event,
    level: input.error ? "warn" : "info",
    sessionId: input.agentSessionId ?? undefined,
    workspaceId: input.workspaceId
  });
}

function agentComposerSettingsChanges(
  previousSettings: AgentHostAgentSessionComposerSettings | undefined,
  nextSettings: AgentHostAgentSessionComposerSettings
): AgentComposerSettingsChange[] {
  const previousPermissionMode =
    resolveComposerPermissionMode(previousSettings);
  const nextPermissionMode = resolveComposerPermissionMode(nextSettings);
  const changes: AgentComposerSettingsChange[] = [];
  for (const change of [
    stringSettingChange("model", previousSettings?.model, nextSettings.model),
    stringSettingChange(
      "permissionModeId",
      previousPermissionMode,
      nextPermissionMode
    ),
    booleanSettingChange(
      "planMode",
      previousSettings?.planMode,
      nextSettings.planMode
    ),
    stringSettingChange(
      "reasoningEffort",
      previousSettings?.reasoningEffort,
      nextSettings.reasoningEffort
    )
  ]) {
    if (change) {
      changes.push(change);
    }
  }
  return changes;
}

function stringSettingChange(
  field: "model" | "permissionModeId" | "reasoningEffort",
  previousValue: string | null | undefined,
  nextValue: string | null | undefined
): { field: typeof field; from: string | null; to: string | null } | null {
  const from = normalizedOptionalSetting(previousValue);
  const to = normalizedOptionalSetting(nextValue);
  return from === to ? null : { field, from, to };
}

function booleanSettingChange(
  field: "planMode",
  previousValue: boolean | null | undefined,
  nextValue: boolean | null | undefined
): { field: typeof field; from: boolean | null; to: boolean | null } | null {
  const from = previousValue ?? null;
  const to = nextValue ?? null;
  return from === to ? null : { field, from, to };
}

function normalizedOptionalSetting(
  value: string | null | undefined
): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function flattenAgentComposerSettingsChanges(
  changes: AgentComposerSettingsChange[]
): Record<string, boolean | string | null> {
  const details: Record<string, boolean | string | null> = {};
  for (const change of changes) {
    details[`${change.field}From`] = change.from;
    details[`${change.field}To`] = change.to;
  }
  return details;
}

function stringifyDiagnosticError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
