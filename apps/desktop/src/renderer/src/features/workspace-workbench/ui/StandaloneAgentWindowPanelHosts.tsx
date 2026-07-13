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
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "@tutti-os/agent-gui/workbench/contribution";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import { AgentEnvPanel } from "@renderer/features/workspace-agent/ui/AgentEnvPanel.tsx";
import type { IAgentProviderStatusService as AgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import { ExternalAgentSessionImportPrompt } from "./ExternalAgentSessionImportPrompt";
import { ExternalAgentSessionImportWizard } from "./ExternalAgentSessionImportWizard";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import { useWorkspaceWorkbenchHostService } from "./useWorkspaceWorkbenchHostService";
import type { WorkspaceSettingsSectionID } from "../services/workspaceSettingsService.interface";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper";

interface StandaloneAgentWindowPanelHostsProps {
  agentProviderStatusService: AgentProviderStatusService;
  host: WorkbenchHostHandle;
  workspace: WorkspaceSummary;
}

export function StandaloneAgentWindowPanelHosts({
  agentProviderStatusService,
  host,
  workspace
}: StandaloneAgentWindowPanelHostsProps): ReactNode {
  const { service: workspaceSettingsService } = useWorkspaceSettingsService();
  const workbenchHostService = useWorkspaceWorkbenchHostService();
  const settingsPanelRequest = useWorkspaceSettingsPanelRequest();
  const lastHandledSettingsRequestRef = useRef(
    settingsPanelRequest.requestSequence
  );
  const [externalImportWizardProviders, setExternalImportWizardProviders] =
    useState<WorkspaceAgentProvider[] | undefined>(undefined);
  const [externalImportWizardOpen, setExternalImportWizardOpen] =
    useState(false);
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
  const openExternalAgentImport = useCallback(
    (providers?: WorkspaceAgentProvider[]) => {
      setExternalImportWizardProviders(providers);
      setExternalImportWizardOpen(true);
    },
    []
  );
  useEffect(() => {
    const openImportWizard = (): void => {
      openExternalAgentImport();
    };
    window.addEventListener(
      AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT,
      openImportWizard
    );
    return () => {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT,
        openImportWizard
      );
    };
  }, [openExternalAgentImport]);
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

  useEffect(() => {
    if (
      settingsPanelRequest.requestSequence ===
      lastHandledSettingsRequestRef.current
    ) {
      return;
    }
    lastHandledSettingsRequestRef.current =
      settingsPanelRequest.requestSequence;
    workspaceSettingsService.openPanel(
      { id: workspace.id },
      settingsPanelRequest.section
        ? {
            section: settingsPanelRequest.section as WorkspaceSettingsSectionID
          }
        : undefined
    );
  }, [settingsPanelRequest, workspace.id, workspaceSettingsService]);

  return (
    <>
      <WorkspaceSettingsPanel
        onOpenExternalAgentImport={() => openExternalAgentImport()}
        onSelectWallpaper={selectWallpaper}
        onSelectWallpaperDisplayMode={selectWallpaperDisplayMode}
        selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
        selectedWallpaperID={selectedWallpaperID}
        workspace={workspace}
      />
      <ExternalAgentSessionImportPrompt
        workspaceId={workspace.id}
        onOpenImport={openExternalAgentImport}
      />
      <ExternalAgentSessionImportWizard
        initialProviders={externalImportWizardProviders}
        open={externalImportWizardOpen}
        workspace={workspace}
        onOpenChange={setExternalImportWizardOpen}
      />
      <AgentEnvPanel
        agentProviderStatusService={agentProviderStatusService}
        workspaceId={workspace.id}
        workbenchHost={host}
      />
    </>
  );
}
