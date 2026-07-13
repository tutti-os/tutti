import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { useWorkspaceSettingsPanelRequest } from "@tutti-os/agent-gui/workspace-settings-panel";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchHostHandle,
  WorkbenchHostLaunchInput
} from "@tutti-os/workbench-surface";
import {
  AgentEnvPanel,
  DesktopAgentProviderManageDialog,
  type AgentProviderStatusService
} from "@renderer/features/workspace-agent";
import type { DesktopApi } from "@preload/types";
import type { DesktopAgentWindowFeature } from "../services/standaloneAgentWindowIntent.ts";
import type { WorkspaceSettingsSectionID } from "../services/workspaceSettingsService.interface.ts";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper.ts";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel.tsx";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService.ts";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService.ts";
import { WorkspaceAgentMessageCenterAction } from "./WorkspaceAgentMessageCenterAction.tsx";
import { useWorkspaceExternalAgentSessionImportHost } from "./useWorkspaceExternalAgentSessionImportHost.tsx";

export function StandaloneAgentWindowPanelHosts({
  agentFeature,
  agentProviderStatusService,
  desktopApi,
  focusedProvider,
  fusionWindowId,
  host,
  onLaunchNode,
  workspace
}: {
  agentFeature: DesktopAgentWindowFeature | null;
  agentProviderStatusService: AgentProviderStatusService;
  desktopApi: DesktopApi;
  focusedProvider: WorkspaceAgentProvider;
  fusionWindowId: string | null;
  host: WorkbenchHostHandle;
  onLaunchNode(input: WorkbenchHostLaunchInput): Promise<string | null>;
  workspace: WorkspaceSummary;
}): ReactNode {
  const { service: workspaceSettingsService } = useWorkspaceSettingsService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const settingsPanelRequest = useWorkspaceSettingsPanelRequest();
  const lastHandledSettingsRequestRef = useRef(
    settingsPanelRequest.requestSequence
  );
  const [manageDialogOpen, setManageDialogOpen] = useState(
    agentFeature === "manage"
  );
  const [messageCenterOpen, setMessageCenterOpen] = useState(
    agentFeature === "message-center"
  );
  const wallpaperRevision = useSyncExternalStore(
    (listener) => workbenchHostService.subscribeWallpaperChanges(listener),
    () => workbenchHostService.getWallpaperRevision(),
    () => workbenchHostService.getWallpaperRevision()
  );
  const selectedWallpaperID = useMemo(
    () => workbenchHostService.readWallpaperId(workspace.id),
    [wallpaperRevision, workbenchHostService, workspace.id]
  );
  const selectedWallpaperDisplayMode = useMemo(
    () => workbenchHostService.readWallpaperDisplayMode(workspace.id),
    [wallpaperRevision, workbenchHostService, workspace.id]
  );
  const { host: externalAgentImportHost, openExternalAgentImport } =
    useWorkspaceExternalAgentSessionImportHost({ workspace });

  useEffect(() => {
    if (
      settingsPanelRequest.requestSequence ===
      lastHandledSettingsRequestRef.current
    ) {
      return;
    }
    lastHandledSettingsRequestRef.current =
      settingsPanelRequest.requestSequence;
    if (fusionWindowId) {
      void desktopApi.fusion.openWindow({
        forceNew: true,
        kind: "settings",
        launchPayload: settingsPanelRequest.section
          ? { section: settingsPanelRequest.section }
          : undefined,
        workspaceId: workspace.id
      });
      return;
    }
    workspaceSettingsService.openPanel(
      { id: workspace.id },
      settingsPanelRequest.section
        ? {
            section: settingsPanelRequest.section as WorkspaceSettingsSectionID
          }
        : undefined
    );
  }, [
    desktopApi.fusion,
    fusionWindowId,
    settingsPanelRequest,
    workspace.id,
    workspaceSettingsService
  ]);

  const selectWallpaper = useCallback(
    (wallpaperId: WorkspaceWallpaperId) => {
      workbenchHostService.writeWallpaperId(workspace.id, wallpaperId);
    },
    [workbenchHostService, workspace.id]
  );
  const selectWallpaperDisplayMode = useCallback(
    (displayMode: WorkspaceWallpaperDisplayMode) => {
      workbenchHostService.writeWallpaperDisplayMode(workspace.id, displayMode);
    },
    [workbenchHostService, workspace.id]
  );

  return (
    <>
      {fusionWindowId ? null : (
        <WorkspaceSettingsPanel
          onOpenExternalAgentImport={() => openExternalAgentImport()}
          onSelectWallpaper={selectWallpaper}
          onSelectWallpaperDisplayMode={selectWallpaperDisplayMode}
          selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
          selectedWallpaperID={selectedWallpaperID}
          workspace={workspace}
        />
      )}
      {externalAgentImportHost}
      <AgentEnvPanel
        agentProviderStatusService={agentProviderStatusService}
        workspaceId={workspace.id}
        workbenchHost={host}
      />
      <DesktopAgentProviderManageDialog
        agentProviderStatusService={agentProviderStatusService}
        focusedProvider={focusedProvider}
        open={manageDialogOpen}
        workbenchHost={host}
        workspaceId={workspace.id}
        onOpenChange={setManageDialogOpen}
      />
      {agentFeature === "message-center" ? (
        <div className="absolute right-4 top-3 z-[var(--z-panel-popover)] [-webkit-app-region:no-drag]">
          <WorkspaceAgentMessageCenterAction
            handlesNotificationNavigation={false}
            launchNode={onLaunchNode}
            open={messageCenterOpen}
            setOpen={setMessageCenterOpen}
            workspace={workspace}
          />
        </div>
      ) : null}
    </>
  );
}
