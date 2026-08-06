import type { AgentGUIRuntime } from "@tutti-os/agent-gui";
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
import { createOptionalReporterService } from "./internal/agentMessageSentAnalytics.ts";
import { resolveDesktopAgentGUIProvider } from "./internal/desktopAgentHostProjection.ts";
import { reportAgentSessionSettingsChanges } from "./internal/agentSessionSettingsAnalytics.ts";
import type { IWorkspaceAgentActivityService } from "./workspaceAgentActivityService.interface";
import {
  agentActivityMessageDiagnosticDetails,
  agentActivityMessagePageDiagnosticSignature,
  agentActivitySnapshotDiagnosticDetails,
  agentActivitySnapshotDiagnosticSignature,
  reportSessionEventDiagnostic
} from "./desktopAgentRuntimeStateDiagnostics.ts";
import { logAgentComposerSettingsDiagnostic } from "./desktopAgentRuntimeSubmitDiagnostics.ts";
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
}

export function createDesktopAgentActivityRuntime(
  workspaceAgentActivityService: IWorkspaceAgentActivityService,
  options: CreateDesktopAgentActivityRuntimeOptions = {}
): AgentGUIRuntime {
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
    input: Parameters<AgentGUIRuntime["listSessionMessages"]>[0],
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
  const archiveAgentPromptFile = options.hostFilesApi?.archiveAgentPromptFile;
  const readLocalPreviewFile = options.hostFilesApi?.readLocalPreviewFile;
  const conversationRailRuntime = createAgentConversationRailRuntime(
    workspaceAgentActivityService
  );
  return {
    ...conversationRailRuntime,
    conversationActivityViewEnabled: true,
    origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
    promptContentUploadSupport: {
      file: Boolean(archiveAgentPromptFile),
      image: Boolean(archiveAgentPromptFile)
    },
    getSessionEngine(workspaceId) {
      return workspaceAgentActivityService.getSessionEngine(workspaceId);
    },
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
    ...(archiveAgentPromptFile
      ? {
          async stagePastedText(
            input: Parameters<
              NonNullable<AgentGUIRuntime["stagePastedText"]>
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
              NonNullable<AgentGUIRuntime["uploadPromptContent"]>
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
              NonNullable<AgentGUIRuntime["readPromptAsset"]>
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
              NonNullable<AgentGUIRuntime["setCollaborationAdoption"]>
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
    subscribe: (workspaceId, listener) =>
      workspaceAgentActivityService.subscribe(workspaceId, (snapshot) => {
        reportSnapshotDiagnostic(workspaceId, snapshot, "subscribe");
        listener(snapshot);
      })
  };
}
