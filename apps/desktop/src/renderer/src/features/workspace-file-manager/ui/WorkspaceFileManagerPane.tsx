import {
  createWorkspaceFileManagerI18nRuntime,
  type WorkspaceFileManagerPersistedState,
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
    mode?: "reveal" | "open-directory";
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
  const referenceCopy = useMemo<WorkspaceFileReferenceCopy>(
    () => createWorkspaceFileReferenceCopy(appI18n),
    [appI18n]
  );
  const referenceSourceAggregator = useMemo(
    () => featureService.getReferenceSourceAggregator(workspaceID, locale),
    [featureService, locale, workspaceID]
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
          workspaceId={workspaceID}
        />
      );
    },
    [
      featureService.hostOs,
      i18n,
      referenceCopy,
      referenceSourceAggregator,
      resolveEntryIconUrl,
      workspaceID
    ]
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
      renderExternalLocationContent={renderExternalLocationContent}
      session={session}
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
