import { useMemo } from "react";
import type { WorkspaceFileReferenceCopy } from "@tutti-os/workspace-file-reference/contracts";
import type { TranslateFn } from "../../i18n/index";

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

export function useAgentGUIWorkspaceFileReferenceCopy(
  t: TranslateFn
): WorkspaceFileReferenceCopy {
  return useMemo<WorkspaceFileReferenceCopy>(
    () => ({
      t(key, values) {
        const localeKey = workspaceFileReferenceLocaleKeyByPickerKey[key];
        return localeKey ? t(localeKey, values) : key;
      }
    }),
    [t]
  );
}
