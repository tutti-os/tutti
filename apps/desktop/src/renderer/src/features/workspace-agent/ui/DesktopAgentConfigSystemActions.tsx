import {
  DownloadIcon,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  RefreshIcon
} from "@tutti-os/ui-system";
import { useAppUpdateService } from "@renderer/features/app-update";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceSettingsService } from "../../workspace-workbench/ui/useWorkspaceSettingsService";

export function DesktopAgentConfigSystemActions(): React.JSX.Element {
  const { t } = useTranslation();
  const { service: appUpdateService, state: appUpdateState } =
    useAppUpdateService();
  const { service: settingsService, state: settingsState } =
    useWorkspaceSettingsService();

  const exportLogs = (input: {
    includeAgentSessions: boolean;
    scope: "recent-10-minutes" | "recent-3-days";
  }): void => {
    void settingsService.exportDeveloperLogs(input);
  };
  return (
    <>
      <DropdownMenuItem
        className="h-7"
        data-testid="agent-gui-config-check-updates"
        disabled={appUpdateState.isActing}
        onSelect={() => void appUpdateService.checkForUpdates()}
      >
        <RefreshIcon aria-hidden="true" className="size-4" />
        <span>
          {appUpdateState.isActing
            ? t("updates.checkingTitle")
            : t("desktop.menu.checkForUpdates")}
        </span>
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          className="h-7"
          data-testid="agent-gui-config-export-logs"
          disabled={settingsState.developerLogs.exporting}
        >
          <DownloadIcon aria-hidden="true" className="size-4" />
          <span>{t("workspace.settings.developer.exportLogs")}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className="nodrag w-64 [-webkit-app-region:no-drag]"
          sideOffset={4}
          style={{ zIndex: "calc(var(--z-panel-popover) + 1)" }}
        >
          <DropdownMenuItem
            disabled={settingsState.developerLogs.exporting}
            onSelect={() =>
              exportLogs({
                includeAgentSessions: false,
                scope: "recent-10-minutes"
              })
            }
          >
            {t("workspace.settings.developer.exportRecentTenMinutesLogsOnly")}
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
            {t(
              "workspace.settings.developer.exportRecentTenMinutesLogsWithSessions"
            )}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={settingsState.developerLogs.exporting}
            onSelect={() =>
              exportLogs({
                includeAgentSessions: false,
                scope: "recent-3-days"
              })
            }
          >
            {t("workspace.settings.developer.exportRecentThreeDaysLogsOnly")}
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
            {t(
              "workspace.settings.developer.exportRecentThreeDaysLogsWithSessions"
            )}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
