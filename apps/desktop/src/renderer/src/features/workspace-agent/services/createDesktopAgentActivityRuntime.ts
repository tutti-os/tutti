import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
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
      const activation =
        await workspaceAgentActivityService.activateSession(input);
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
    getSnapshot: (workspaceId) =>
      workspaceAgentActivityService.getSnapshot(workspaceId),
    listSessionMessages: (input) =>
      workspaceAgentActivityService.listSessionMessages(input),
    load: (workspaceId, signal) =>
      workspaceAgentActivityService.load(workspaceId, signal),
    ensureSessionSynchronized: (input) =>
      workspaceAgentActivityService.ensureSessionSynchronized(input),
    retainSessionEvents: (input) =>
      workspaceAgentActivityService.retainSessionEvents(input),
    async sendInput(input) {
      const session = await workspaceAgentActivityService.sendInput(input);
      await messageSentTracker.track({
        agentSessionId: session.agentSessionId,
        prompt: promptContentDisplayText(input.content),
        provider: session.provider
      });
      return session;
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
      void options.runtimeApi
        ?.logRendererDiagnostic({
          details: input.details ?? {},
          event: input.event,
          level: input.level ?? "info",
          source: input.source ?? "agent-gui",
          workspaceId: input.workspaceId ?? undefined
        })
        .catch(() => {});
    },
    ...(options.warmupOpenclawGateway
      ? {
          warmupOpenclawGateway: options.warmupOpenclawGateway
        }
      : {}),
    subscribeSessionEvents: (workspaceId, listener) =>
      workspaceAgentActivityService.onSessionEvent(workspaceId, listener),
    unactivateSession: (input) =>
      workspaceAgentActivityService.unactivateSession(input),
    submitInteractive: (input) =>
      workspaceAgentActivityService.submitInteractive(input),
    subscribe: (workspaceId, listener) =>
      workspaceAgentActivityService.subscribe(workspaceId, listener)
  };
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
