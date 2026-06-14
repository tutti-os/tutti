import {
  createWorkspaceFileManagerI18nRuntime,
  type WorkspaceFileManagerPersistedState,
  WorkspaceFileManager
} from "@tutti-os/workspace-file-manager";
import browserDockIconUrl from "@tutti-os/browser-node/assets/workspace-dock-website.png";
import { useService } from "@tutti-os/infra/di";
import { useCallback, useEffect, useMemo } from "react";
import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager/services";
import { resolveOpenWithApplicationIconOverrideDataUrl } from "@shared/openWithApplicationIconOverrides";
import { FileManagerDirectoryExpandedReporter } from "@renderer/features/analytics/reporters/file-manager-directory-expanded/fileManagerDirectoryExpandedReporter.ts";
import { FileManagerPathCopiedReporter } from "@renderer/features/analytics/reporters/file-manager-path-copied/fileManagerPathCopiedReporter.ts";
import { IReporterService } from "@renderer/features/analytics";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import { useWorkspaceFileManagerService } from "./useWorkspaceFileManagerService";

interface WorkspaceFileManagerPaneProps {
  className?: string;
  revealIntent?: {
    path: string;
    requestID: string;
  } | null;
  restoredState?: WorkspaceFileManagerPersistedState | null;
  workspaceID: string;
}

export function WorkspaceFileManagerPane({
  className,
  revealIntent = null,
  restoredState = null,
  workspaceID
}: WorkspaceFileManagerPaneProps) {
  const { i18n: appI18n, locale } = useTranslation();
  const reporterService = useService(IReporterService);
  const featureService = useWorkspaceFileManagerService();
  const i18n = useMemo(
    () => createWorkspaceFileManagerI18nRuntime(appI18n),
    [appI18n]
  );
  const session = useMemo(
    () => featureService.getSession(workspaceID, i18n, restoredState),
    [featureService, i18n, restoredState, workspaceID]
  );

  useEffect(() => {
    session.setActive(true);
    void session.initialize();

    return () => {
      session.setActive(false);
    };
  }, [reporterService, session]);

  useEffect(() => {
    void session.applyRevealIntent(revealIntent);
  }, [revealIntent, session]);

  const resolveEntryIconUrl = useCallback(
    (entry: WorkspaceFileEntry) =>
      featureService.resolveEntryIconUrl(workspaceID, entry),
    [featureService, workspaceID]
  );

  return (
    <WorkspaceFileManager
      className={className}
      dateLocale={locale}
      hostOs={featureService.hostOs}
      i18n={i18n}
      openInAppBrowserIcon={
        <img
          alt=""
          className="size-4 rounded-[4px] object-contain"
          src={browserDockIconUrl}
        />
      }
      resolveOpenWithApplicationIcon={(application) => {
        const iconDataUrl =
          resolveOpenWithApplicationIconOverrideDataUrl(application);
        return iconDataUrl ? (
          <img
            alt=""
            className="size-4 rounded-[4px] object-contain"
            src={iconDataUrl}
          />
        ) : null;
      }}
      onCopyEntry={() => {
        Toast.Success(appI18n.t("workspaceFileManager.copySuccessTitle"));
      }}
      onCopyPath={async (path) => {
        await navigator.clipboard.writeText(path);
        void new FileManagerPathCopiedReporter(
          {},
          {
            reporterService
          }
        ).report();
        Toast.Success(appI18n.t("workspaceFileManager.copyPathSuccessTitle"));
      }}
      onDirectoryExpanded={(path) => {
        void new FileManagerDirectoryExpandedReporter(
          {
            depth: resolveDirectoryDepth(path)
          },
          {
            reporterService
          }
        ).report();
      }}
      resolveEntryIconUrl={resolveEntryIconUrl}
      session={session}
      surface="embedded"
    />
  );
}

function resolveDirectoryDepth(path: string): number {
  const normalizedPath = path.replace(/\\/gu, "/");
  return Math.max(
    1,
    normalizedPath.split("/").filter((part) => part.length > 0).length
  );
}
