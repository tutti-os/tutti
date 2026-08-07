import { useEffect, useRef } from "react";
import type * as React from "react";
import type { WorkspaceSummary } from "@tutti-os/client-tuttid-ts";
import {
  AppWindowIcon,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  AskLinedIcon,
  LockLayoutLinedIcon,
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
import { WorkspaceConnectorMarketDialogHost } from "./WorkspaceConnectorMarketDialogHost";
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
    isLayoutLocked: boolean;
    isOpen: boolean;
    open(trigger?: "button" | "keyboard"): void;
    unlockLayout(): void;
    visibleWindowCount: number;
  };
  platform: NodeJS.Platform;
}) {
  const { t } = useTranslation();
  const isDarwin = platform === "darwin";
  const TriggerIcon = missionControl.isLayoutLocked
    ? LockLayoutLinedIcon
    : AppWindowIcon;
  // A locked layout must be released before the overview can open, so the
  // first click on the locked entry unlocks and the second click opens.
  const unlockFirst = missionControl.isLayoutLocked && !missionControl.isOpen;

  return (
    <div className="flex items-center gap-1">
      <WorkspaceMissionControlAction
        active={missionControl.isOpen}
        disabled={!missionControl.canOpen}
        label={t(
          unlockFirst
            ? "workspace.workbenchDesktop.missionControl.unlockLayoutTrigger"
            : "workspace.workbenchDesktop.missionControl.layoutTrigger"
        )}
        shortcutLabel={
          unlockFirst
            ? undefined
            : t(
                isDarwin
                  ? "workspace.workbenchDesktop.missionControl.layoutShortcutMac"
                  : "workspace.workbenchDesktop.missionControl.layoutShortcutDefault"
              )
        }
        unavailableLabel={t(
          "workspace.workbenchDesktop.missionControl.unavailableTrigger"
        )}
        onClick={() => {
          if (missionControl.isOpen) {
            missionControl.close();
            return;
          }
          if (missionControl.isLayoutLocked) {
            missionControl.unlockLayout();
            return;
          }
          missionControl.open("button");
        }}
      >
        <TriggerIcon className="size-4" />
      </WorkspaceMissionControlAction>
    </div>
  );
}

/**
 * Windows keeps the native application menu available through Alt, but does
 * not render its extra menu row in the normal workspace chrome. Keep the
 * support-facing Help actions discoverable in the existing custom header.
 */
export function WorkspaceHelpMenu({
  platform,
  workspace
}: {
  platform: NodeJS.Platform;
  workspace: WorkspaceSummary;
}) {
  const { t } = useTranslation();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();

  if (platform !== "win32") {
    return null;
  }

  const exportLogs = (input: {
    includeAgentSessions: boolean;
    scope: "recent-10-minutes" | "recent-3-days";
  }) => {
    void settingsService.exportDeveloperLogs(input);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t("desktop.menu.help")}
          className="text-[var(--workbench-chrome-foreground)]"
          size="icon-sm"
          title={t("desktop.menu.help")}
          type="button"
          variant="ghost"
        >
          <AskLinedIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72"
        style={{ zIndex: "var(--z-panel-popover)" }}
      >
        <DropdownMenuLabel>{t("desktop.menu.help")}</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() =>
            settingsService.openPanel(
              { id: workspace.id },
              { section: "about" }
            )
          }
        >
          {t("workspace.settings.nav.about")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("desktop.menu.exportRecentTenMinutesLogs")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuItem
              disabled={settingsState.developerLogs.exporting}
              onSelect={() =>
                exportLogs({
                  includeAgentSessions: false,
                  scope: "recent-10-minutes"
                })
              }
            >
              {t("desktop.menu.logsOnly")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={settingsState.developerLogs.exporting}
              onSelect={() =>
                exportLogs({
                  includeAgentSessions: true,
                  scope: "recent-10-minutes"
                })
              }
            >
              {t("desktop.menu.logsWithAgentSessions")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {t("desktop.menu.exportRecentThreeDaysLogs")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            <DropdownMenuItem
              disabled={settingsState.developerLogs.exporting}
              onSelect={() =>
                exportLogs({
                  includeAgentSessions: false,
                  scope: "recent-3-days"
                })
              }
            >
              {t("desktop.menu.logsOnly")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={settingsState.developerLogs.exporting}
              onSelect={() =>
                exportLogs({
                  includeAgentSessions: true,
                  scope: "recent-3-days"
                })
              }
            >
              {t("desktop.menu.logsWithAgentSessions")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
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
      settingsPanelRequest.section || settingsPanelRequest.pane
        ? {
            section: settingsPanelRequest.section
              ? (settingsPanelRequest.section as WorkspaceSettingsSectionID)
              : undefined,
            pane: settingsPanelRequest.pane ?? undefined,
            provider: settingsPanelRequest.provider ?? undefined
          }
        : undefined
    );
  }, [settingsPanelRequest, settingsService, workspace.id]);

  return (
    <>
      <WorkspaceConnectorMarketDialogHost />
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
              onClick={() =>
                settingsService.openPanel(
                  { id: workspace.id },
                  { section: "general" }
                )
              }
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
