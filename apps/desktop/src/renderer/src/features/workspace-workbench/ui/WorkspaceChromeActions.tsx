import { useEffect, useRef } from "react";
import type * as React from "react";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import type { WorkbenchMissionControlMode } from "@tutti-os/workbench-surface";
import {
  AppWindowIcon,
  Button,
  OverviewLayoutIcon,
  SettingsIcon,
  ShortcutBadge,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { useWorkspaceSettingsPanelRequest } from "@tutti-os/agent-gui/workspace-settings-panel";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel";
import { useWorkspaceSettingsService } from "./useWorkspaceSettingsService";
import type { WorkspaceSettingsSectionID } from "../services/workspaceSettingsService.interface";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "../services/workspaceWallpaper";

export function WorkspaceMissionControlActions({
  missionControl,
  platform
}: {
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
  platform: NodeJS.Platform;
}) {
  const { t } = useTranslation();
  const isDarwin = platform === "darwin";

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
  shortcutLabel: string;
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
            <ShortcutBadge>{shortcutLabel}</ShortcutBadge>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceSettingsTrigger({
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
