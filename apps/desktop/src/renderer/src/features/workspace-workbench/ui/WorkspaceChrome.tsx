import { useCallback, useEffect, useState } from "react";
import type * as React from "react";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchHostChromeRenderContext,
  WorkbenchController,
  WorkbenchHostNodeData,
  WorkbenchMissionControlMode
} from "@tutti-os/workbench-surface";
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "@tutti-os/agent-gui/workbench/contribution";
import { cn } from "@renderer/lib/format";
import { ExternalAgentSessionImportPrompt } from "./ExternalAgentSessionImportPrompt";
import { ExternalAgentSessionImportWizard } from "./ExternalAgentSessionImportWizard";
import { WorkspaceAccountMenu } from "./WorkspaceAccountMenu";
import { WorkspaceFeedbackGroupPopover } from "./WorkspaceFeedbackGroupPopover";
import { WorkspaceAgentMessageCenterAction } from "./WorkspaceAgentMessageCenterAction";
import {
  WorkspaceMissionControlActions,
  WorkspaceSettingsTrigger
} from "./WorkspaceChromeActions";
import { useWorkspaceChromeState } from "./useWorkspaceChromeState";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper";

const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX = 16;
const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_GUTTER_PX = 64;
const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_RESERVED_WIDTH_PX =
  WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX +
  WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_GUTTER_PX;

export function WorkspaceChrome({
  headerSlot,
  missionControl,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  platform,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  wallpaperAppearance,
  launchNode,
  workbenchController,
  workspace
}: {
  headerSlot?: React.ReactNode;
  missionControl: {
    canOpen: boolean;
    close(): void;
    isOpen: boolean;
    mode: WorkbenchMissionControlMode | null;
    open(
      mode: WorkbenchMissionControlMode,
      trigger?: "button" | "keyboard"
    ): void;
    visibleWindowCount: number;
  };
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  platform: NodeJS.Platform;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  wallpaperAppearance: "dark" | "light";
  launchNode?: WorkbenchHostChromeRenderContext["launchNode"];
  workbenchController?: WorkbenchController<WorkbenchHostNodeData>;
  workspace: WorkspaceSummary;
}) {
  const isDarwin = platform === "darwin";
  const isWindows = platform === "win32";
  const chromeState = useWorkspaceChromeState({
    platform,
    workbenchController
  });
  const headerStyle = isDarwin
    ? ({
        "--workspace-chrome-left-padding": chromeState.useCompactTitlebar
          ? `${WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX}px`
          : `calc(${WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX}px + var(--cove-workspace-mac-traffic-light-gutter, ${WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_GUTTER_PX}px))`
      } as React.CSSProperties)
    : undefined;
  const [messageCenterOpen, setMessageCenterOpen] = useState(false);
  const [externalImportWizardProviders, setExternalImportWizardProviders] =
    useState<WorkspaceAgentProvider[] | undefined>(undefined);
  const [externalImportWizardOpen, setExternalImportWizardOpen] =
    useState(false);
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

  return (
    <>
      <header
        className={cn(
          "grid min-h-[52px] items-center gap-4 bg-transparent px-4",
          messageCenterOpen
            ? "[-webkit-app-region:no-drag]"
            : "[-webkit-app-region:drag]",
          "grid-cols-[max-content_minmax(0,1fr)_max-content]",
          isDarwin && "pl-[var(--workspace-chrome-left-padding)]",
          isWindows &&
            "pr-[calc(100vw-env(titlebar-area-width,calc(100vw-138px))+10px)]"
        )}
        data-app-header="true"
        style={headerStyle}
      >
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          {isDarwin && !chromeState.useCompactTitlebar ? (
            <div
              aria-hidden="true"
              className="h-full shrink-0 [-webkit-app-region:no-drag]"
              style={{
                width: `${WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_RESERVED_WIDTH_PX}px`
              }}
            />
          ) : null}
        </div>
        <div aria-hidden="true" className="min-w-0" />
        <div
          className="flex items-center justify-end gap-2 justify-self-end [-webkit-app-region:no-drag]"
          data-workbench-wallpaper-appearance={wallpaperAppearance}
        >
          {headerSlot ? <div className="min-w-0">{headerSlot}</div> : null}
          <WorkspaceFeedbackGroupPopover />
          <WorkspaceAgentMessageCenterAction
            launchNode={launchNode}
            open={messageCenterOpen}
            setOpen={setMessageCenterOpen}
            workspace={workspace}
          />
          <WorkspaceMissionControlActions
            missionControl={missionControl}
            platform={platform}
          />
          <WorkspaceSettingsTrigger
            onOpenExternalAgentImport={() => openExternalAgentImport()}
            onSelectWallpaper={onSelectWallpaper}
            onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
            selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
            selectedWallpaperID={selectedWallpaperID}
            workspace={workspace}
          />
          <WorkspaceAccountMenu />
        </div>
      </header>
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
    </>
  );
}
