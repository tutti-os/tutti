import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from "react";
import { WorkspaceFileReferencePicker } from "@tutti-os/workspace-file-reference/ui";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "@tutti-os/workspace-file-reference/contracts";
import type {
  DesktopWorkspaceAppExternalHostApi,
  DesktopWorkspaceAppExternalHostRequestResult
} from "@preload/types";
import type {
  DesktopWorkspaceAppExternalRendererEvent,
  DesktopWorkspaceAppExternalRendererRequest
} from "@shared/contracts/ipc";
import type {
  TuttiExternalAgentActivityComposerOptions,
  TuttiExternalAgentTargetCatalog,
  TuttiExternalFileOpenInput
} from "@tutti-os/workspace-external-core/contracts";
import { resolveWorkspaceMentionLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import { runDesktopAgentGUILinkAction } from "@renderer/features/workspace-agent/services/desktopAgentGUILinkActions.ts";
import { IWorkspaceAgentActivityService } from "@renderer/features/workspace-agent/services/workspaceAgentActivityService.interface.ts";
import { IAgentsService } from "@renderer/features/workspace-agent/services/agentsService.interface.ts";
import type { AgentHostAgentSessionComposerSettings } from "@shared/contracts/dto";
import { useService } from "@tutti-os/infra/di";
import { requestGroupChatLaunch } from "../services/groupChatLaunchCoordinator.ts";
import { requestWorkspaceAgentGuiLaunch } from "@renderer/features/workspace-agent/services/workspaceAgentGuiLaunchCoordinator.ts";
import { useWorkspaceAppCenterService } from "@renderer/features/workspace-app-center";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { requestWorkspaceIssueManagerLaunch } from "../services/workspaceIssueManagerLaunchCoordinator";

const workspaceFileReferenceLocaleKeyByPickerKey: Record<string, string> = {
  "actions.cancel": "common.cancel",
  "referencePicker.confirm": "agentHost.agentGui.referencePicker.confirm",
  "referencePicker.emptyDirectory":
    "agentHost.agentGui.referencePicker.emptyDirectory",
  "referencePicker.emptySearch":
    "agentHost.agentGui.referencePicker.emptySearch",
  "referencePicker.loading": "agentHost.agentGui.referencePicker.loading",
  "referencePicker.previewBinary":
    "agentHost.agentGui.referencePicker.previewBinary",
  "referencePicker.previewDecodeFailed":
    "agentHost.agentGui.referencePicker.previewDecodeFailed",
  "referencePicker.previewError":
    "agentHost.agentGui.referencePicker.previewError",
  "referencePicker.previewFileTooLarge":
    "agentHost.agentGui.referencePicker.previewFileTooLarge",
  "referencePicker.previewFolder":
    "agentHost.agentGui.referencePicker.previewFolder",
  "referencePicker.previewLoading":
    "agentHost.agentGui.referencePicker.previewLoading",
  "referencePicker.previewTextTooLarge":
    "agentHost.agentGui.referencePicker.previewTextTooLarge",
  "referencePicker.previewUnavailable":
    "agentHost.agentGui.referencePicker.previewUnavailable",
  "referencePicker.previewUnsupported":
    "agentHost.agentGui.referencePicker.previewUnsupported",
  "referencePicker.searchPlaceholder":
    "agentHost.agentGui.referencePicker.searchPlaceholder",
  "referencePicker.selectedCount":
    "agentHost.agentGui.referencePicker.selectedCount",
  "referencePicker.title": "agentHost.agentGui.referencePicker.title"
};

function toAgentHostComposerSettings(
  settings:
    | import("@tutti-os/agent-activity-core").AgentActivitySessionSettings
    | null
    | undefined
): AgentHostAgentSessionComposerSettings | null | undefined {
  if (settings === null || settings === undefined) {
    return settings;
  }
  return {
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.permissionModeId !== undefined
      ? { permissionModeId: settings.permissionModeId }
      : {}),
    ...(typeof settings.planMode === "boolean"
      ? { planMode: settings.planMode }
      : {}),
    ...(typeof settings.browserUse === "boolean"
      ? { browserUse: settings.browserUse }
      : {}),
    ...(typeof settings.computerUse === "boolean"
      ? { computerUse: settings.computerUse }
      : {}),
    ...(settings.reasoningEffort !== undefined
      ? { reasoningEffort: settings.reasoningEffort }
      : {}),
    ...(settings.speed !== undefined ? { speed: settings.speed } : {})
  };
}

interface WorkspaceAppExternalBridgeProps {
  api?: DesktopWorkspaceAppExternalHostApi;
  openFile: (input: TuttiExternalFileOpenInput) => Promise<void>;
  workspaceId: string;
}

interface PendingFileSelect {
  multiple: boolean;
  resolve: (refs: WorkspaceFileReference[]) => void;
}

export function WorkspaceAppExternalBridge({
  api,
  openFile,
  workspaceId
}: WorkspaceAppExternalBridgeProps): ReactElement | null {
  const hostService = useWorkspaceWorkbenchHostService();
  const { service: settingsService } = useWorkspaceSettingsService();
  const { service: appCenterService, state: appCenterState } =
    useWorkspaceAppCenterService();
  const workspaceAgentActivityService = useService(
    IWorkspaceAgentActivityService
  );
  const agentsService = useService(IAgentsService);
  const { t } = useTranslation();
  const [pendingFileSelect, setPendingFileSelect] =
    useState<PendingFileSelect | null>(null);
  const pendingFileSelectRef = useRef<PendingFileSelect | null>(null);
  const fileAdapter = useMemo(
    () =>
      hostService.createWorkspaceAppExternalFileReferenceAdapter(workspaceId),
    [hostService, workspaceId]
  );
  const userProjectsApi = useMemo(
    () => hostService.createWorkspaceAppExternalUserProjectApi(),
    [hostService]
  );
  const copy = useMemo<WorkspaceFileReferenceCopy>(
    () => ({
      t(key, values) {
        const localeKey =
          workspaceFileReferenceLocaleKeyByPickerKey[key] ?? key;
        return t(localeKey as Parameters<typeof t>[0], values);
      }
    }),
    [t]
  );
  useEffect(() => {
    if (!api || !userProjectsApi.getSnapshot || !userProjectsApi.subscribe) {
      return;
    }
    let disposed = false;
    const sendSnapshot = (
      snapshot?: Awaited<
        ReturnType<NonNullable<typeof userProjectsApi.getSnapshot>>
      >
    ): void => {
      if (disposed) {
        return;
      }
      if (!snapshot) {
        void userProjectsApi.getSnapshot?.().then(sendSnapshot, () => {});
        return;
      }
      const event: DesktopWorkspaceAppExternalRendererEvent = {
        snapshot,
        type: "userProjects.changed",
        workspaceId
      };
      api.sendEvent(event);
    };
    const unsubscribe = userProjectsApi.subscribe(sendSnapshot);
    void userProjectsApi.getSnapshot().then(sendSnapshot, () => {});
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api, userProjectsApi, workspaceId]);

  useEffect(() => {
    if (!api) return;
    api.sendEvent({
      invalidation: {
        providerIds: ["workspace-app"],
        revision: appCenterState.revision
      },
      type: "at.invalidated",
      workspaceId
    });
  }, [api, appCenterState.revision, workspaceId]);

  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = workspaceAgentActivityService.subscribe(
      workspaceId,
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          api.sendEvent({
            invalidation: {
              providerIds: ["agent-session", "agent-generated-file"]
            },
            type: "at.invalidated",
            workspaceId
          });
        }, 100);
      }
    );
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [api, workspaceAgentActivityService, workspaceId]);

  useEffect(() => {
    if (!api) return;
    return agentsService.subscribe(() => {
      api.sendEvent({
        invalidation: { providerIds: ["agent-target"] },
        type: "at.invalidated",
        workspaceId
      });
    });
  }, [agentsService, api, workspaceId]);

  const resolvePendingFileSelect = useCallback(
    (refs: WorkspaceFileReference[]) => {
      const pending = pendingFileSelectRef.current;
      if (!pending) {
        return;
      }
      pendingFileSelectRef.current = null;
      setPendingFileSelect(null);
      pending.resolve(pending.multiple ? refs : refs.slice(0, 1));
    },
    []
  );

  const openFileSelect = useCallback(
    (multiple: boolean) =>
      new Promise<WorkspaceFileReference[]>((resolve) => {
        const pending: PendingFileSelect = { multiple, resolve };
        pendingFileSelectRef.current?.resolve([]);
        pendingFileSelectRef.current = pending;
        setPendingFileSelect(pending);
      }),
    []
  );

  const handleRequest = useCallback(
    async (
      request: DesktopWorkspaceAppExternalRendererRequest
    ): Promise<DesktopWorkspaceAppExternalHostRequestResult> => {
      if (request.workspaceId !== workspaceId) {
        throw new Error("Workspace app external request workspace mismatch.");
      }
      switch (request.operation) {
        case "agentActivity.listTargets": {
          const snapshot = await agentsService.load();
          return {
            agents: snapshot.agents.map((agent) => ({
              agentTargetId: agent.agentTargetId,
              availability: { ...agent.availability },
              ...(agent.description ? { description: agent.description } : {}),
              iconUrl: agent.iconUrl,
              name: agent.name,
              provider: agent.provider
            })),
            capturedAtUnixMs: snapshot.capturedAtUnixMs,
            error: snapshot.error,
            status: snapshot.status
          } satisfies TuttiExternalAgentTargetCatalog;
        }
        case "agentActivity.getComposerOptions":
          return (await workspaceAgentActivityService.getComposerOptions({
            agentTargetId: request.input.agentTargetId,
            cwd: request.input.cwd,
            provider: request.input.provider,
            settings: toAgentHostComposerSettings(request.input.settings),
            workspaceId
          })) as TuttiExternalAgentActivityComposerOptions;
        case "agentActivity.activateSession":
          return workspaceAgentActivityService.activateSession({
            agentSessionId: request.input.agentSessionId,
            agentTargetId: request.input.agentTargetId,
            clientSubmitId: request.input.clientSubmitId,
            ...(request.input.cwd ? { cwd: request.input.cwd } : {}),
            initialContent: request.input.initialContent,
            ...(request.input.initialDisplayPrompt !== undefined
              ? { initialDisplayPrompt: request.input.initialDisplayPrompt }
              : {}),
            mode: "new",
            ...(request.input.settings
              ? { settings: request.input.settings }
              : {}),
            ...(request.input.title ? { title: request.input.title } : {}),
            ...(request.input.visible !== undefined
              ? { visible: request.input.visible }
              : {}),
            workspaceId
          });
        case "agentActivity.sendInput":
          return workspaceAgentActivityService.sendInput({
            agentSessionId: request.input.agentSessionId,
            clientSubmitId: request.input.clientSubmitId,
            content: request.input.content,
            ...(request.input.displayPrompt !== undefined
              ? { displayPrompt: request.input.displayPrompt }
              : {}),
            ...(request.input.guidance !== undefined
              ? { guidance: request.input.guidance }
              : {}),
            workspaceId
          });
        case "agentActivity.cancelTurn":
          if (!workspaceAgentActivityService.cancelTurn) {
            throw new Error("Agent activity cancellation is unavailable.");
          }
          return workspaceAgentActivityService.cancelTurn({
            agentSessionId: request.input.agentSessionId,
            turnId: request.input.turnId,
            workspaceId
          });
        case "agentActivity.getSnapshot":
          return workspaceAgentActivityService.load(workspaceId);
        case "at.query":
          return hostService.queryWorkspaceAppExternalAt({
            query: request.input,
            workspaceId
          });
        case "at.resolve":
          return hostService.resolveWorkspaceAppExternalAt({
            mention: request.input,
            workspaceId
          });
        case "files.select":
          return openFileSelect(request.input.multiple === true);
        case "files.open":
          await openFile(request.input);
          return undefined;
        case "settings.open":
          settingsService.openPanel(
            { id: workspaceId },
            {
              ...(request.input.provider || request.input.tab === "models"
                ? { pane: "managed-models" }
                : {}),
              ...(request.input.provider
                ? { provider: request.input.provider }
                : {})
            }
          );
          return undefined;
        case "references.open": {
          const action = resolveWorkspaceMentionLinkAction({
            href: request.input.href,
            source: "workspace-app"
          });
          if (!action) {
            throw new Error("Unsupported reference link.");
          }
          const opened = await runDesktopAgentGUILinkAction(action, {
            getAgentSession: ({ agentSessionId, workspaceId }) =>
              workspaceAgentActivityService.getSession(
                workspaceId,
                agentSessionId
              ),
            launchAgentGui: requestWorkspaceAgentGuiLaunch,
            launchWorkspaceApp: async ({ appId, workspaceId }) => {
              await appCenterService.openApp({ appId, workspaceId });
              return true;
            },
            launchGroupChat: requestGroupChatLaunch,
            launchWorkspaceFiles: () => false,
            launchWorkspaceIssueManager: requestWorkspaceIssueManagerLaunch,
            openBrowserUrl: () => false,
            workspaceId
          });
          if (!opened) {
            throw new Error("Unable to open reference link.");
          }
          return undefined;
        }
        case "userProjects.checkPath":
          return userProjectsApi.checkPath?.(request.input);
        case "userProjects.create":
          return userProjectsApi.create?.(request.input);
        case "userProjects.getDefaultSelection":
          return userProjectsApi.getDefaultSelection?.() ?? null;
        case "userProjects.getSnapshot":
          return userProjectsApi.getSnapshot?.();
        case "userProjects.list":
          return userProjectsApi.list();
        case "userProjects.move":
          await userProjectsApi.move?.(request.input);
          return undefined;
        case "userProjects.prepareSelection":
          return userProjectsApi.prepareSelection?.(request.input);
        case "userProjects.refresh":
          return userProjectsApi.refresh?.();
        case "userProjects.rememberDefaultSelection":
          await userProjectsApi.rememberDefaultSelection?.(request.input);
          return undefined;
        case "userProjects.selectDirectory":
          return userProjectsApi.selectDirectory?.() ?? null;
        case "userProjects.use":
          return userProjectsApi.use?.(request.input);
      }
    },
    [
      appCenterService,
      hostService,
      openFile,
      openFileSelect,
      settingsService,
      userProjectsApi,
      workspaceAgentActivityService,
      workspaceId
    ]
  );

  useEffect(() => {
    if (!api) {
      return undefined;
    }
    return api.onRequest(handleRequest);
  }, [api, handleRequest]);

  useEffect(() => {
    return () => {
      pendingFileSelectRef.current?.resolve([]);
      pendingFileSelectRef.current = null;
    };
  }, []);

  return (
    <WorkspaceFileReferencePicker
      copy={copy}
      fileAdapter={fileAdapter}
      open={pendingFileSelect !== null}
      workspaceId={workspaceId}
      onClose={() => resolvePendingFileSelect([])}
      onConfirm={resolvePendingFileSelect}
    />
  );
}
