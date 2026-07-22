import type { AgentActivityRuntime } from "@tutti-os/agent-gui";
import { createAgentConversationRailRuntime } from "@tutti-os/agent-gui/conversation-rail-runtime";
import { AGENT_SESSION_ENGINE_LOCAL_ORIGIN } from "@tutti-os/agent-activity-core";
import type {
  AgentActivityMessagePage,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { DesktopHostFilesApi, DesktopRuntimeApi } from "@preload/types";
import type { IReporterService } from "../../analytics/services/reporterService.interface.ts";
import { AgentConversationPinnedReporter } from "../../analytics/reporters/agent-conversation-pinned/agentConversationPinnedReporter.ts";
import { AgentConversationUnpinnedReporter } from "../../analytics/reporters/agent-conversation-unpinned/agentConversationUnpinnedReporter.ts";
import { AgentSettingsProjectChangedReporter } from "../../analytics/reporters/agent-settings-project-changed/agentSettingsProjectChangedReporter.ts";
import {
  createAgentMessageSentTracker,
  createOptionalReporterService
} from "./internal/agentMessageSentAnalytics.ts";
import {
  createAgentSessionStartedTracker,
  resolveAgentSessionSource
} from "./internal/agentSessionStartedAnalytics.ts";
import {
  normalizeComposerSettings,
  resolveComposerPermissionMode,
  resolveDesktopAgentGUIProvider
} from "./internal/desktopAgentHostProjection.ts";
import { reportAgentSessionSettingsChanges } from "./internal/agentSessionSettingsAnalytics.ts";
import {
  AgentAnalyticsErrorCode,
  createAgentNodeResultTracker,
  safeTrackAgentNodeResult
} from "./internal/agentNodeResultAnalytics.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import type { IWorkspaceUserProjectService } from "../../workspace-user-project/index.ts";
import {
  agentActivityMessageDiagnosticDetails,
  agentActivityMessagePageDiagnosticSignature,
  agentActivitySnapshotDiagnosticDetails,
  agentActivitySnapshotDiagnosticSignature,
  reportSessionEventDiagnostic
} from "./desktopAgentRuntimeStateDiagnostics.ts";
import {
  logAgentComposerSettingsDiagnostic,
  promptContentDisplayText,
  reportAgentSubmitTraceDiagnostic
} from "./desktopAgentRuntimeSubmitDiagnostics.ts";
import { uint8ArrayToBase64 } from "./internal/desktopAgentPromptAssetEncoding.ts";

interface CreateDesktopAgentActivityRuntimeOptions {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
  hostFilesApi?: Partial<
    Pick<DesktopHostFilesApi, "archiveAgentPromptFile" | "readLocalPreviewFile">
  >;
  runtimeApi?: Pick<
    DesktopRuntimeApi,
    "logRendererDiagnostic" | "logTerminalDiagnostic"
  >;
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
      level: "debug",
      workspaceId: input.workspaceId
    });
  };
  const messageSentTracker = createAgentMessageSentTracker({
    reporterNow: options.reporterNow,
    reporterService: options.reporterService
  });
  const sessionStartedTracker = createAgentSessionStartedTracker({
    reporterNow: options.reporterNow,
    reporterService: options.reporterService
  });
  const nodeResultTracker = createAgentNodeResultTracker({
    reporterNow: options.reporterNow,
    reporterService: options.reporterService
  });
  const archiveAgentPromptFile = options.hostFilesApi?.archiveAgentPromptFile;
  const readLocalPreviewFile = options.hostFilesApi?.readLocalPreviewFile;
  const conversationRailRuntime = createAgentConversationRailRuntime(
    workspaceAgentActivityService
  );
  return {
    ...conversationRailRuntime,
    origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
    promptContentUploadSupport: {
      file: Boolean(archiveAgentPromptFile),
      image: Boolean(archiveAgentPromptFile)
    },
    getSessionEngine(workspaceId) {
      return workspaceAgentActivityService.getSessionEngine(workspaceId);
    },
    async activateSession(input) {
      reportAgentSubmitTraceDiagnostic(options.runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.mode === "new" ? input.clientSubmitId : null,
        event: "activity_runtime.activate.entered",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId,
        fields: {
          mode: input.mode,
          provider: null
        }
      });
      const flow = "session_create" as const;
      const node = "activate_session" as const;
      const fallbackErrorCode =
        input.mode === "existing"
          ? AgentAnalyticsErrorCode.SessionResumeFailed
          : AgentAnalyticsErrorCode.SessionCreateFailed;
      let activation: Awaited<
        ReturnType<IWorkspaceAgentActivityService["activateSession"]>
      >;
      try {
        activation = await workspaceAgentActivityService.activateSession(input);
      } catch (error) {
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: input.agentSessionId,
          error,
          fallbackErrorCode,
          flow,
          node,
          provider: null,
          success: false
        });
        throw error;
      }
      reportAgentSubmitTraceDiagnostic(options.runtimeApi, {
        agentSessionId: activation.session.agentSessionId,
        clientSubmitId: input.mode === "new" ? input.clientSubmitId : null,
        event: "activity_runtime.activate.resolved",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId,
        fields: {
          mode: input.mode,
          provider: activation.session.provider,
          activationStatus: activation.activation.status
        }
      });
      const activationFailed = activation.activation.status === "failed";
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: activation.session.agentSessionId,
        error: activationFailed
          ? (activation.error?.message ??
            activation.error?.code ??
            "Agent session activation failed.")
          : undefined,
        fallbackErrorCode,
        flow,
        node,
        provider: activation.session.provider,
        success: !activationFailed
      });
      if (input.mode === "new" && !activationFailed) {
        await sessionStartedTracker.track({
          agentSessionId: activation.session.agentSessionId,
          clientSubmitId: input.clientSubmitId,
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
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: activation.session.agentSessionId,
          flow,
          node: "session_started_reported",
          provider: activation.session.provider,
          success: true
        });
        const initialPrompt =
          input.initialDisplayPrompt?.trim() ||
          promptContentDisplayText(input.initialContent ?? []);
        if (initialPrompt) {
          await messageSentTracker.track({
            agentSessionId: activation.session.agentSessionId,
            clientSubmitId: input.clientSubmitId,
            prompt: initialPrompt,
            provider: activation.session.provider
          });
          await safeTrackAgentNodeResult(nodeResultTracker, {
            agentSessionId: activation.session.agentSessionId,
            flow,
            node: "message_sent_reported",
            provider: activation.session.provider,
            success: true
          });
        }
      }
      return activation;
    },
    goalControl: (input) => workspaceAgentActivityService.goalControl(input),
    createSession: (input) =>
      workspaceAgentActivityService.createSession(input),
    deleteSession: (input) =>
      workspaceAgentActivityService.deleteSession(input),
    getComposerOptions: (input) =>
      workspaceAgentActivityService.getComposerOptions(input),
    getSession: (workspaceId, agentSessionId) =>
      workspaceAgentActivityService.getSession(workspaceId, agentSessionId),
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
    async sendInput(input) {
      reportAgentSubmitTraceDiagnostic(options.runtimeApi, {
        agentSessionId: input.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "activity_runtime.send.entered",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId
      });
      let result: Awaited<
        ReturnType<IWorkspaceAgentActivityService["sendInput"]>
      >;
      try {
        result = await workspaceAgentActivityService.sendInput(input);
      } catch (error) {
        await safeTrackAgentNodeResult(nodeResultTracker, {
          agentSessionId: input.agentSessionId,
          error,
          fallbackErrorCode: AgentAnalyticsErrorCode.RuntimeExecFailed,
          flow: "message_send",
          node: "send_input_request",
          provider: null,
          success: false
        });
        throw error;
      }
      reportAgentSubmitTraceDiagnostic(options.runtimeApi, {
        agentSessionId: result.session.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        event: "activity_runtime.send.resolved",
        submitDiagnostics: input.submitDiagnostics,
        workspaceId: input.workspaceId,
        fields:
          result.kind === "goalControl"
            ? {
                provider: result.session.provider,
                resultKind: "goalControl"
              }
            : {
                provider: result.session.provider,
                resultKind: "turn",
                turnOutcome: result.turn.outcome ?? null,
                turnId: result.turnId,
                turnPhase: result.turn.phase
              }
      });
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: result.session.agentSessionId,
        flow: "message_send",
        node: "send_input_request",
        provider: result.session.provider,
        success: true
      });
      await messageSentTracker.track({
        agentSessionId: result.session.agentSessionId,
        clientSubmitId: input.clientSubmitId,
        isQueued: input.submitDiagnostics?.queued,
        prompt:
          input.displayPrompt?.trim() ||
          promptContentDisplayText(input.content),
        provider: result.session.provider
      });
      await safeTrackAgentNodeResult(nodeResultTracker, {
        agentSessionId: result.session.agentSessionId,
        flow: "message_send",
        node: "message_sent_reported",
        provider: result.session.provider,
        success: true
      });
      return result;
    },
    ...(archiveAgentPromptFile
      ? {
          async stagePastedText(
            input: Parameters<
              NonNullable<AgentActivityRuntime["stagePastedText"]>
            >[0]
          ) {
            const archived = await archiveAgentPromptFile({
              workspaceID: input.workspaceId,
              dataBase64: uint8ArrayToBase64(
                new TextEncoder().encode(input.text)
              ),
              displayName: input.name,
              mimeType: "text/plain"
            });
            return {
              name: archived.name,
              path: archived.path,
              sizeBytes: archived.sizeBytes
            };
          },
          async uploadPromptContent(
            input: Parameters<
              NonNullable<AgentActivityRuntime["uploadPromptContent"]>
            >[0]
          ) {
            const content = await Promise.all(
              input.content.map(async (block) => {
                if (block.type === "file") {
                  const hostPath = block.hostPath?.trim() ?? "";
                  const inlineData = block.data?.trim() ?? "";
                  if (!hostPath && !inlineData) {
                    throw new Error(
                      "Prompt file upload requires hostPath or data."
                    );
                  }
                  const archived = await archiveAgentPromptFile({
                    workspaceID: input.workspaceId,
                    ...(hostPath ? { hostPath } : { dataBase64: inlineData }),
                    displayName: block.name ?? null,
                    mimeType: block.mimeType ?? null
                  });
                  const blockWithoutData = { ...block };
                  delete blockWithoutData.data;
                  return {
                    ...blockWithoutData,
                    name: archived.name,
                    path: archived.path,
                    sizeBytes: archived.sizeBytes,
                    uploadStatus: "uploaded"
                  };
                }
                if (block.type === "image" && block.data) {
                  const archived = await archiveAgentPromptFile({
                    workspaceID: input.workspaceId,
                    dataBase64: block.data,
                    displayName: block.name ?? null,
                    mimeType: block.mimeType ?? null
                  });
                  const blockWithoutData = { ...block };
                  delete blockWithoutData.data;
                  return {
                    ...blockWithoutData,
                    name: archived.name,
                    path: archived.path,
                    sizeBytes: archived.sizeBytes,
                    uploadStatus: "uploaded"
                  };
                }
                return block;
              })
            );
            return { content };
          }
        }
      : {}),
    readSessionAttachment: (input) =>
      workspaceAgentActivityService.readSessionAttachment(input),
    ...(readLocalPreviewFile
      ? {
          async readPromptAsset(
            input: Parameters<
              NonNullable<AgentActivityRuntime["readPromptAsset"]>
            >[0]
          ) {
            const path = input.path?.trim() ?? "";
            if (!path) {
              throw new Error("Prompt asset path is required.");
            }
            const bytes = await readLocalPreviewFile(path);
            return {
              data: uint8ArrayToBase64(bytes),
              mimeType: input.mimeType,
              name: input.name ?? undefined,
              path
            };
          }
        }
      : {}),
    renameSession: (input) =>
      workspaceAgentActivityService.renameSession(input),
    ...(workspaceAgentActivityService.setCollaborationAdoption
      ? {
          setCollaborationAdoption: (
            input: Parameters<
              NonNullable<AgentActivityRuntime["setCollaborationAdoption"]>
            >[0]
          ) => workspaceAgentActivityService.setCollaborationAdoption!(input)
        }
      : {}),
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
      const previousState = await workspaceAgentActivityService.getSession(
        input.workspaceId,
        input.agentSessionId
      );
      const previousSettings = normalizeComposerSettings(
        previousState.settings ?? {}
      );
      logAgentComposerSettingsDiagnostic({
        agentSessionId: input.agentSessionId,
        event: "agent.gui.composer_settings.update_requested",
        nextSettings: input.settings,
        previousSettings,
        provider: previousState.provider,
        runtimeApi: options.runtimeApi,
        source: "session",
        workspaceId: input.workspaceId
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
          previousSettings,
          provider: previousState.provider,
          runtimeApi: options.runtimeApi,
          source: "session",
          workspaceId: input.workspaceId
        });
        throw error;
      }
      const normalizedResult = {
        ...result,
        settings: normalizeComposerSettings(result.settings)
      };
      await reportAgentSessionSettingsChanges({
        agentSessionId: normalizedResult.agentSessionId,
        nextSettings: normalizedResult.settings,
        previousSettings,
        provider: previousState.provider,
        reporterNow: options.reporterNow,
        reporterService: options.reporterService
      });
      logAgentComposerSettingsDiagnostic({
        agentSessionId: normalizedResult.agentSessionId,
        event: "agent.gui.composer_settings.changed",
        nextSettings: normalizedResult.settings,
        previousSettings,
        provider: previousState.provider,
        runtimeApi: options.runtimeApi,
        source: "session",
        workspaceId: input.workspaceId
      });
      return normalizedResult;
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
