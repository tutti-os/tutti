import {
  DownloadIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  RefreshIcon
} from "@tutti-os/ui-system";
import { useAppUpdateService } from "@renderer/features/app-update";
import { useTranslation } from "@renderer/i18n";
import { useWorkspaceSettingsService } from "../../workspace-workbench/ui/useWorkspaceSettingsService";

const actionClassName =
  "nodrag flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-[13px] text-[var(--text-primary)] transition-colors hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:text-[var(--text-tertiary)] [-webkit-app-region:no-drag]";

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
    <div className="flex min-w-0 flex-col gap-1">
      <button
        className={actionClassName}
        data-testid="agent-gui-config-check-updates"
        disabled={appUpdateState.isActing}
        onClick={() => void appUpdateService.checkForUpdates()}
        type="button"
      >
        <RefreshIcon aria-hidden="true" className="size-4" />
        <span>
          {appUpdateState.isActing
            ? t("updates.checkingTitle")
            : t("desktop.menu.checkForUpdates")}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={actionClassName}
            data-testid="agent-gui-config-export-logs"
            disabled={settingsState.developerLogs.exporting}
            type="button"
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            <span>{t("workspace.settings.developer.exportLogs")}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64"
          side="right"
          style={{ zIndex: "calc(var(--z-panel-popover) + 1)" }}
        >
          <DropdownMenuItem
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
