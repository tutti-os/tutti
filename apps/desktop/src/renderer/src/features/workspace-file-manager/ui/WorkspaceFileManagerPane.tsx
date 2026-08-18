import {
  createWorkspaceFileManagerI18nRuntime,
  type WorkspaceFileManagerPersistedState,
  type WorkspaceFileManagerPreviewActionsConfig,
  WorkspaceFileManager
} from "@tutti-os/workspace-file-manager";
import { ReferenceSourceContentPane } from "@tutti-os/workspace-file-reference/ui";
import type {
  NodeRef,
  WorkspaceFileReferenceCopy
} from "@tutti-os/workspace-file-reference/contracts";
import browserDockIconUrl from "@tutti-os/browser-node/assets/workspace-dock-website.png";
import { useService } from "@tutti-os/infra/di";
import { useCallback, useEffect, useMemo } from "react";
import type { WorkspaceFileEntry } from "@tutti-os/workspace-file-manager/services";
import type { WorkspaceFileExternalLocation } from "@tutti-os/workspace-file-manager/services";
import type { WorkspaceFileOpenWithApplication } from "@tutti-os/workspace-file-manager/services";
import { resolveOpenWithApplicationIconOverrideDataUrl } from "@shared/openWithApplicationIconOverrides";
import { FileManagerDirectoryExpandedReporter } from "@renderer/features/analytics/reporters/file-manager-directory-expanded/fileManagerDirectoryExpandedReporter.ts";
import { FileManagerPathCopiedReporter } from "@renderer/features/analytics/reporters/file-manager-path-copied/fileManagerPathCopiedReporter.ts";
import { IReporterService } from "@renderer/features/analytics";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import { useWorkspaceFileManagerService } from "./useWorkspaceFileManagerService";
import { createDesktopWorkspaceFileManagerContextMenu } from "./createDesktopWorkspaceFileManagerContextMenu";

/**
 * Desktop only exposes the actions the package already implements. Download and
 * share stay product-owned and are not part of this host.
 */
const desktopWorkspaceFilePreviewActions: WorkspaceFileManagerPreviewActionsConfig =
  {
    copy: true,
    open: true
  };

interface WorkspaceFileManagerPaneProps {
  className?: string;
  locationSidebarLayout?: {
    contentMinWidth?: number;
    defaultWidth?: number;
    maxWidth?: number;
    persistWidth?: boolean;
  };
  revealIntent?: {
    mode?: "select" | "open";
    path: string;
    requestID: string;
  } | null;
  restoredState?: WorkspaceFileManagerPersistedState | null;
  showInternalOpenWithActions?: boolean;
  showPreviewPanel?: boolean;
  workspaceID: string;
}

export function WorkspaceFileManagerPane({
  className,
  locationSidebarLayout,
  revealIntent = null,
  restoredState = null,
  showInternalOpenWithActions = true,
  showPreviewPanel = true,
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
  const referenceCopy = useMemo<WorkspaceFileReferenceCopy>(
    () => createWorkspaceFileReferenceCopy(appI18n),
    [appI18n]
  );
  const referenceSourceAggregator = useMemo(
    () => featureService.getReferenceSourceAggregator(workspaceID, locale),
    [featureService, locale, workspaceID]
  );
  const resolveOpenWithApplicationIcon = useCallback(
    (application: WorkspaceFileOpenWithApplication) => {
      const iconDataUrl =
        resolveOpenWithApplicationIconOverrideDataUrl(application);
      return iconDataUrl ? (
        <img
          alt=""
          className="size-4 rounded-[4px] object-contain"
          src={iconDataUrl}
        />
      ) : null;
    },
    []
  );
  const notifyEntryCopied = useCallback(() => {
    Toast.Success(appI18n.t("workspaceFileManager.copySuccessTitle"));
  }, [appI18n]);
  const resolveContextMenu = useMemo(
    () =>
      createDesktopWorkspaceFileManagerContextMenu({
        appI18n,
        hostOs: featureService.hostOs,
        i18n,
        onCopyEntry: notifyEntryCopied,
        onCopyPath: async (path) => {
          await navigator.clipboard.writeText(path);
          void new FileManagerPathCopiedReporter(
            {},
            {
              reporterService
            }
          ).report();
          Toast.Success(appI18n.t("workspaceFileManager.copyPathSuccessTitle"));
        },
        openInAppBrowserIcon: (
          <img
            alt=""
            className="size-4 rounded-[4px] object-contain"
            src={browserDockIconUrl}
          />
        ),
        resolveOpenWithApplicationIcon,
        session,
        showInternalOpenWithActions
      }),
    [
      appI18n,
      featureService.hostOs,
      i18n,
      reporterService,
      resolveOpenWithApplicationIcon,
      session,
      showInternalOpenWithActions
    ]
  );
  const renderExternalLocationContent = useCallback(
    (location: WorkspaceFileExternalLocation) => {
      if (location.externalType !== "workspace-reference") {
        return null;
      }
      const initialNodeRef = externalLocationToNodeRef(location);
      if (!initialNodeRef) {
        return null;
      }
      return (
        <ReferenceSourceContentPane
          key={location.id}
          aggregator={referenceSourceAggregator}
          copy={referenceCopy}
          fileManagerCopy={i18n}
          hostOs={featureService.hostOs}
          initialNodeRef={initialNodeRef}
          resolveEntryIconUrl={resolveEntryIconUrl}
          resolveOpenWithApplicationIcon={resolveOpenWithApplicationIcon}
          workspaceId={workspaceID}
        />
      );
    },
    [
      featureService.hostOs,
      i18n,
      notifyEntryCopied,
      referenceCopy,
      referenceSourceAggregator,
      resolveOpenWithApplicationIcon,
      resolveEntryIconUrl,
      workspaceID
    ]
  );

  return (
    <WorkspaceFileManager
      className={className}
      dateLocale={locale}
      pathDisplayPlatform={featureService.hostOs}
      i18n={i18n}
      locationSidebarLayout={locationSidebarLayout}
      onCopyEntry={notifyEntryCopied}
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
      previewActions={desktopWorkspaceFilePreviewActions}
      resolveContextMenu={resolveContextMenu}
      resolveEntryIconUrl={resolveEntryIconUrl}
      renderExternalLocationContent={renderExternalLocationContent}
      session={session}
      showPreviewPanel={showPreviewPanel}
      surface="embedded"
    />
  );
}

const workspaceFileReferenceLocaleKeyByPickerKey: Record<string, string> = {
  "actions.cancel": "common.cancel",
  "referencePicker.confirm": "agentHost.agentGui.referencePicker.confirm",
  "referencePicker.clearFilter":
    "agentHost.agentGui.referencePicker.clearFilter",
  "referencePicker.emptyDirectory":
    "agentHost.agentGui.referencePicker.emptyDirectory",
  "referencePicker.emptyPreview":
    "agentHost.agentGui.referencePicker.emptyPreview",
  "referencePicker.emptySearch":
    "agentHost.agentGui.referencePicker.emptySearch",
  "referencePicker.fileTypeAll":
    "agentHost.agentGui.referencePicker.fileTypeAll",
  "referencePicker.fileTypeDocument":
    "agentHost.agentGui.referencePicker.fileTypeDocument",
  "referencePicker.fileTypeImage":
    "agentHost.agentGui.referencePicker.fileTypeImage",
  "referencePicker.fileTypeOther":
    "agentHost.agentGui.referencePicker.fileTypeOther",
  "referencePicker.fileTypeSeparator":
    "agentHost.agentGui.referencePicker.fileTypeSeparator",
  "referencePicker.fileTypeVideo":
    "agentHost.agentGui.referencePicker.fileTypeVideo",
  "referencePicker.fileTypeWebpage":
    "agentHost.agentGui.referencePicker.fileTypeWebpage",
  "referencePicker.loadMore": "agentHost.agentGui.referencePicker.loadMore",
  "referencePicker.loadMoreGroups":
    "agentHost.agentGui.referencePicker.loadMoreGroups",
  "referencePicker.loading": "agentHost.agentGui.referencePicker.loading",
  "referencePicker.loadError": "agentHost.agentGui.referencePicker.loadError",
  "referencePicker.previewBinary":
    "agentHost.agentGui.referencePicker.previewBinary",
  "referencePicker.previewDecodeFailed":
    "agentHost.agentGui.referencePicker.previewDecodeFailed",
  "referencePicker.previewError":
    "agentHost.agentGui.referencePicker.previewError",
  "referencePicker.previewFileTooLarge":
    "agentHost.agentGui.referencePicker.previewFileTooLarge",
  "referencePicker.previewFolder":
    "agentHost.agentGui.referencePicker.previewFolder",
  "referencePicker.previewHierarchy":
    "agentHost.agentGui.referencePicker.previewHierarchy",
  "referencePicker.previewLoading":
    "agentHost.agentGui.referencePicker.previewLoading",
  "referencePicker.previewModified":
    "agentHost.agentGui.referencePicker.previewModified",
  "referencePicker.previewSize":
    "agentHost.agentGui.referencePicker.previewSize",
  "referencePicker.previewSource":
    "agentHost.agentGui.referencePicker.previewSource",
  "referencePicker.previewTextTooLarge":
    "agentHost.agentGui.referencePicker.previewTextTooLarge",
  "referencePicker.previewTooLarge":
    "agentHost.agentGui.referencePicker.previewTooLarge",
  "referencePicker.previewUnavailable":
    "agentHost.agentGui.referencePicker.previewUnavailable",
  "referencePicker.previewUnsupported":
    "agentHost.agentGui.referencePicker.previewUnsupported",
  "referencePicker.searchPlaceholder":
    "agentHost.agentGui.referencePicker.searchPlaceholder",
  "referencePicker.selectGroupHint":
    "agentHost.agentGui.referencePicker.selectGroupHint",
  "referencePicker.selectedCount":
    "agentHost.agentGui.referencePicker.selectedCount",
  "referencePicker.workspaceRootGroup":
    "agentHost.agentGui.referencePicker.workspaceRootGroup",
  "referencePicker.sourceColumn":
    "agentHost.agentGui.referencePicker.sourceColumn",
  "referencePicker.title": "agentHost.agentGui.referencePicker.title"
};

function createWorkspaceFileReferenceCopy(i18n: {
  t(key: string, values?: Record<string, number | string>): string;
}): WorkspaceFileReferenceCopy {
  return {
    t(key, values) {
      return i18n.t(
        workspaceFileReferenceLocaleKeyByPickerKey[key] ?? key,
        values
      );
    }
  };
}

function externalLocationToNodeRef(
  location: WorkspaceFileExternalLocation
): NodeRef | null {
  const sourceId = location.metadata.sourceId?.trim();
  const nodeId = location.metadata.nodeId?.trim();
  if (!sourceId || !nodeId) {
    return null;
  }
  return { sourceId, nodeId };
}

function resolveDirectoryDepth(path: string): number {
  const normalizedPath = path.replace(/\\/gu, "/");
  return Math.max(
    1,
    normalizedPath.split("/").filter((part) => part.length > 0).length
  );
}
