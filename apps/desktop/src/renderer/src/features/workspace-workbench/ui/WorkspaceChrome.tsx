import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type {
  WorkbenchHostChromeRenderContext,
  WorkbenchController,
  WorkbenchHostNodeData,
  WorkbenchMissionControlMode
} from "@tutti-os/workbench-surface";
import {
  AppWindowIcon,
  Button,
  LockGridHorizontalLinedIcon,
  LockGridVerticalLinedIcon,
  LockLayoutLinedIcon,
  OverviewLayoutIcon,
  SettingsIcon,
  ShortcutBadge,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { WorkspaceAccountMenu } from "./WorkspaceAccountMenu";
import { WorkspaceFeedbackGroupPopover } from "./WorkspaceFeedbackGroupPopover";
import { WorkspaceAgentMessageCenterAction } from "./WorkspaceAgentMessageCenterAction.tsx";
import { WorkspaceAgentWaitingNotificationOwner } from "./WorkspaceAgentWaitingNotificationOwner.tsx";
import { useWorkspaceExternalAgentSessionImportHost } from "./useWorkspaceExternalAgentSessionImportHost.tsx";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel";
import { useWorkspaceChromeState } from "./useWorkspaceChromeState";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import type { WorkspaceSettingsSectionID } from "../services/workspaceSettingsService.interface";
import { useWorkspaceSettingsPanelRequest } from "@tutti-os/agent-gui/workspace-settings-panel";
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
  const { host: externalAgentImportHost, openExternalAgentImport } =
    useWorkspaceExternalAgentSessionImportHost({ workspace });

  return (
    <>
      <WorkspaceAgentWaitingNotificationOwner
        messageCenterOpen={messageCenterOpen}
        workspaceId={workspace.id}
      />
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
            lockedLayoutPreset={chromeState.lockedWorkbenchLayoutPreset}
            missionControl={missionControl}
            platform={platform}
            onReleaseLockedLayout={() =>
              workbenchController?.commands.releaseLockedLayout()
            }
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
      {externalAgentImportHost}
    </>
  );
}

const lockedLayoutPresetIcons = {
  balanced: LockLayoutLinedIcon,
  column: LockGridVerticalLinedIcon,
  row: LockGridHorizontalLinedIcon
} as const;

function WorkspaceMissionControlActions({
  lockedLayoutPreset,
  missionControl,
  platform,
  onReleaseLockedLayout
}: {
  lockedLayoutPreset: "balanced" | "row" | "column" | null;
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
  onReleaseLockedLayout: () => void;
  platform: NodeJS.Platform;
}) {
  const { t } = useTranslation();
  const isDarwin = platform === "darwin";
  const LockedLayoutIcon =
    lockedLayoutPreset === null
      ? null
      : lockedLayoutPresetIcons[lockedLayoutPreset];

  return (
    <div className="flex items-center gap-1">
      <WorkspaceMissionControlAction
        active={missionControl.isOpen && missionControl.mode === "activate"}
        disabled={!missionControl.canOpen}
        label={t("workspace.workbenchDesktop.missionControl.activateTrigger")}
        shortcutLabel={t(
          isDarwin
            ? "workspace.workbenchDesktop.missionControl.activateShortcutMac"
            : "workspace.workbenchDesktop.missionControl.activateShortcutDefault"
        )}
        unavailableLabel={t(
          "workspace.workbenchDesktop.missionControl.unavailableTrigger"
        )}
        onClick={() => {
          if (missionControl.isOpen && missionControl.mode === "activate") {
            missionControl.close();
            return;
          }
          missionControl.open("activate", "button");
        }}
      >
        <OverviewLayoutIcon className="size-4" />
      </WorkspaceMissionControlAction>
      {LockedLayoutIcon ? (
        <WorkspaceMissionControlAction
          active
          disabled={false}
          label={t(
            "workspace.workbenchDesktop.missionControl.unlockLayoutTrigger"
          )}
          unavailableLabel={t(
            "workspace.workbenchDesktop.missionControl.unavailableTrigger"
          )}
          onClick={onReleaseLockedLayout}
        >
          <LockedLayoutIcon className="size-4" />
        </WorkspaceMissionControlAction>
      ) : (
        <WorkspaceMissionControlAction
          active={missionControl.isOpen && missionControl.mode === "layout"}
          disabled={!missionControl.canOpen}
          label={t("workspace.workbenchDesktop.missionControl.layoutTrigger")}
          shortcutLabel={t(
            isDarwin
              ? "workspace.workbenchDesktop.missionControl.layoutShortcutMac"
              : "workspace.workbenchDesktop.missionControl.layoutShortcutDefault"
          )}
          unavailableLabel={t(
            "workspace.workbenchDesktop.missionControl.unavailableTrigger"
          )}
          onClick={() => {
            if (missionControl.isOpen && missionControl.mode === "layout") {
              missionControl.close();
              return;
            }
            missionControl.open("layout", "button");
          }}
        >
          <AppWindowIcon className="size-4" />
        </WorkspaceMissionControlAction>
      )}
    </div>
  );
}

function WorkspaceMissionControlAction({
  active,
  children,
  disabled,
  label,
  onClick,
  shortcutLabel,
  unavailableLabel
}: {
  active: boolean;
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
  shortcutLabel?: string;
  unavailableLabel: string;
}) {
  const button = (
    <Button
      aria-label={label}
      className={cn(
        "text-[var(--workbench-chrome-foreground)]",
        active &&
          "bg-transparency-block text-[var(--workbench-chrome-active-foreground)]"
      )}
      disabled={disabled}
      size="icon-sm"
      title={label}
      type="button"
      variant="ghost"
      onClick={onClick}
    >
      {children}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={disabled ? unavailableLabel : label}
          className={cn("inline-flex", disabled && "cursor-not-allowed")}
          tabIndex={disabled ? 0 : undefined}
        >
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {disabled ? (
          unavailableLabel
        ) : (
          <>
            <span>{label}</span>
            {shortcutLabel ? (
              <ShortcutBadge>{shortcutLabel}</ShortcutBadge>
            ) : null}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function WorkspaceSettingsTrigger({
  onOpenExternalAgentImport,
  onSelectWallpaper,
  onSelectWallpaperDisplayMode,
  selectedWallpaperDisplayMode,
  selectedWallpaperID,
  workspace
}: {
  onOpenExternalAgentImport: () => void;
  onSelectWallpaper: (id: WorkspaceWallpaperId) => void;
  onSelectWallpaperDisplayMode: (
    displayMode: WorkspaceWallpaperDisplayMode
  ) => void;
  selectedWallpaperDisplayMode: WorkspaceWallpaperDisplayMode;
  selectedWallpaperID: WorkspaceWallpaperId;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();

  // Deep-link bridge: the agent-gui rail's "Usage & Settings" popover publishes
  // an open request (with a target section) into a shared store. React to new
  // requests by opening the global settings panel navigated to that section.
  const settingsPanelRequest = useWorkspaceSettingsPanelRequest();
  const lastHandledSettingsRequestRef = useRef(
    settingsPanelRequest.requestSequence
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
    settingsService.openPanel(
      { id: workspace.id },
      settingsPanelRequest.section
        ? {
            section: settingsPanelRequest.section as WorkspaceSettingsSectionID
          }
        : undefined
    );
  }, [settingsPanelRequest, settingsService, workspace.id]);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={t("workspace.settings.trigger")}
            className="inline-flex"
          >
            <Button
              aria-expanded={settingsState.open}
              aria-label={t("workspace.settings.trigger")}
              className={cn(
                "text-[var(--workbench-chrome-foreground)]",
                settingsState.open &&
                  "text-[var(--workbench-chrome-active-foreground)]"
              )}
              size="icon-sm"
              title={t("workspace.settings.trigger")}
              type="button"
              variant="ghost"
              onClick={() => settingsService.openPanel({ id: workspace.id })}
            >
              <SettingsIcon className="size-4" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("workspace.settings.trigger")}</TooltipContent>
      </Tooltip>
      <WorkspaceSettingsPanel
        onOpenExternalAgentImport={onOpenExternalAgentImport}
        onSelectWallpaper={onSelectWallpaper}
        onSelectWallpaperDisplayMode={onSelectWallpaperDisplayMode}
        selectedWallpaperDisplayMode={selectedWallpaperDisplayMode}
        selectedWallpaperID={selectedWallpaperID}
        workspace={workspace}
      />
    </>
  );
}
