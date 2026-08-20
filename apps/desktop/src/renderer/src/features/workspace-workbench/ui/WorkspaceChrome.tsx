import { useCallback, useEffect, useState } from "react";
import type * as React from "react";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchHostChromeRenderContext,
  WorkbenchController,
  WorkbenchHostNodeData
} from "@tutti-os/workbench-surface";
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "@tutti-os/agent-gui/workbench/contribution";
import { cn } from "@renderer/lib/format";
import { ExternalAgentSessionImportPrompt } from "./ExternalAgentSessionImportPrompt";
import { ExternalAgentSessionImportWizard } from "./ExternalAgentSessionImportWizard";
import { WorkspaceAccountMenu } from "./WorkspaceAccountMenu";
import { WorkspaceFeedbackGroupPopover } from "./WorkspaceFeedbackGroupPopover";
import { WorkspaceAgentMessageCenterAction } from "./WorkspaceAgentMessageCenterAction";
import {
  WorkspaceHelpMenu,
  WorkspaceMissionControlActions,
  WorkspaceSettingsTrigger
} from "./WorkspaceChromeActions";
import { useWorkspaceChromeState } from "./useWorkspaceChromeState";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper";

const tuttiWindowIconUrl = new URL(
  "../../app-update/assets/tutti.png",
  import.meta.url
).href;

const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX = 16;
const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_GUTTER_PX = 64;
const WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_RESERVED_WIDTH_PX =
  WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_INSET_PX +
  WORKSPACE_CHROME_MAC_TRAFFIC_LIGHT_GUTTER_PX;
const WORKSPACE_CHROME_TITLEBAR_HEIGHT_PX = 52;

export function WorkspaceChrome({
  appName,
  externalAgentSessionImportPromptEnabled,
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
  appName: string;
  externalAgentSessionImportPromptEnabled: boolean;
  headerSlot?: React.ReactNode;
  missionControl: {
    canOpen: boolean;
    close(): void;
    isLayoutLocked: boolean;
    isOpen: boolean;
    open(trigger?: "button" | "keyboard"): void;
    unlockLayout(): void;
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
          {isWindows && appName ? (
            <div className="flex items-center gap-2 px-1 text-sm font-medium text-white/80 [-webkit-app-region:drag]">
              <img
                alt=""
                className="size-5 shrink-0 object-contain"
                draggable={false}
                src={tuttiWindowIconUrl}
              />
              <span>{appName}</span>
            </div>
          ) : null}
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
          // 顶栏元素始终保持白色，不随亮暗模式 / 壁纸明暗切换
          style={
            {
              "--workbench-chrome-foreground": "var(--white-stationary)",
              "--workbench-chrome-active-foreground": "var(--white-stationary)"
            } as React.CSSProperties
          }
        >
          {headerSlot ? <div className="min-w-0">{headerSlot}</div> : null}
          <WorkspaceFeedbackGroupPopover />
          <WorkspaceAgentMessageCenterAction
            drawerTopInsetPx={
              isWindows ? WORKSPACE_CHROME_TITLEBAR_HEIGHT_PX : undefined
            }
            launchNode={launchNode}
            open={messageCenterOpen}
            setOpen={setMessageCenterOpen}
            workspace={workspace}
          />
          <WorkspaceHelpMenu platform={platform} workspace={workspace} />
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
          <WorkspaceAccountMenu workspaceId={workspace.id} />
        </div>
      </header>
      {externalAgentSessionImportPromptEnabled ? (
        <ExternalAgentSessionImportPrompt
          workspaceId={workspace.id}
          onOpenImport={openExternalAgentImport}
        />
      ) : null}
      <ExternalAgentSessionImportWizard
        initialProviders={externalImportWizardProviders}
        open={externalImportWizardOpen}
        workspace={workspace}
        onOpenChange={setExternalImportWizardOpen}
      />
    </>
  );
}
