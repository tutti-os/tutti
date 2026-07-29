import { useMemo } from "react";

import {
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  ShareLinedIcon
} from "@tutti-os/ui-system/icons";

import type { WorkspaceFileManagerI18nRuntime } from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerState
} from "../services/workspaceFileManagerTypes.ts";
import {
  findWorkspaceFileLocationById,
  isWorkspaceFileExternalLocation
} from "../services/workspaceFileManagerLocations.ts";
import {
  workspaceFileManagerPreviewActionOrder,
  type WorkspaceFileManagerPreviewAction,
  type WorkspaceFileManagerPreviewActionId,
  type WorkspaceFileManagerPreviewActionsConfig
} from "./workspaceFileManagerPreviewActionTypes.ts";

const previewActionIconClassName = "size-4";

/**
 * Resolves the declarative preview-action config against session state. Copy
 * and open dispatch the package's own session commands; download and share
 * forward to host handlers.
 */
export function useWorkspaceFileManagerPreviewActions({
  config,
  copy,
  entry,
  onCopyEntry,
  session,
  state
}: {
  config: WorkspaceFileManagerPreviewActionsConfig | undefined;
  copy: WorkspaceFileManagerI18nRuntime;
  entry: WorkspaceFileEntry | null;
  onCopyEntry?: () => Promise<void> | void;
  session: WorkspaceFileManagerSession;
  state: WorkspaceFileManagerState;
}): readonly WorkspaceFileManagerPreviewAction[] {
  const { busyAction, capabilities, isLoading, isMutating } = state;
  const isExternalLocation = isWorkspaceFileExternalLocation(
    findWorkspaceFileLocationById(
      state.locationSections,
      state.selectedLocationId
    )
  );

  return useMemo(() => {
    if (!config || !entry) {
      return [];
    }

    const disabled = busyAction !== null || isLoading || isMutating;
    const order = config.order ?? workspaceFileManagerPreviewActionOrder;
    const actions: WorkspaceFileManagerPreviewAction[] = [];

    for (const id of order) {
      const action = buildPreviewAction({
        config,
        copy,
        disabled,
        entry,
        id,
        isExternalLocation,
        onCopyEntry,
        session,
        canCopy: capabilities.canCopy
      });

      if (action) {
        actions.push(action);
      }
    }

    return actions;
  }, [
    busyAction,
    capabilities.canCopy,
    config,
    copy,
    entry,
    isExternalLocation,
    isLoading,
    isMutating,
    onCopyEntry,
    session
  ]);
}

function buildPreviewAction({
  canCopy,
  config,
  copy,
  disabled,
  entry,
  id,
  isExternalLocation,
  onCopyEntry,
  session
}: {
  canCopy: boolean;
  config: WorkspaceFileManagerPreviewActionsConfig;
  copy: WorkspaceFileManagerI18nRuntime;
  disabled: boolean;
  entry: WorkspaceFileEntry;
  id: WorkspaceFileManagerPreviewActionId;
  isExternalLocation: boolean;
  onCopyEntry?: () => Promise<void> | void;
  session: WorkspaceFileManagerSession;
}): WorkspaceFileManagerPreviewAction | null {
  switch (id) {
    case "copy": {
      // Mirrors the Cmd/Ctrl+C shortcut: external locations have no clipboard
      // path, and the host opts out entirely by omitting copyEntriesToClipboard.
      if (config.copy !== true || !canCopy || isExternalLocation) {
        return null;
      }

      return {
        disabled,
        icon: <CopyIcon className={previewActionIconClassName} />,
        id,
        label: copy.t("copyLabel"),
        onSelect: () => {
          void (async () => {
            if (await session.copyToClipboard(entry)) {
              await onCopyEntry?.();
            }
          })();
        }
      };
    }
    case "open": {
      if (config.open !== true) {
        return null;
      }

      return {
        disabled,
        icon: <EyeIcon className={previewActionIconClassName} />,
        id,
        label: copy.t("openLabel"),
        onSelect: () => {
          void session.openEntry(entry);
        }
      };
    }
    case "download": {
      const onDownload = config.onDownload;

      if (!onDownload) {
        return null;
      }

      return {
        disabled,
        icon: <DownloadIcon className={previewActionIconClassName} />,
        id,
        label: copy.t("downloadLabel"),
        onSelect: () => {
          void onDownload(entry);
        }
      };
    }
    case "share": {
      const onShare = config.onShare;

      if (!onShare) {
        return null;
      }

      return {
        disabled,
        icon: <ShareLinedIcon className={previewActionIconClassName} />,
        id,
        label: copy.t("shareLabel"),
        onSelect: () => {
          void onShare(entry);
        }
      };
    }
    default:
      return null;
  }
}
