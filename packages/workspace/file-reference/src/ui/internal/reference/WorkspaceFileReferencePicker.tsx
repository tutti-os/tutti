import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  cn
} from "@tutti-os/ui-system";
import { useEffect } from "react";
import type {
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReference,
  WorkspaceFileReferenceCopy
} from "../../../contracts/index.ts";
import { useWorkspaceFileReferencePickerView } from "../../../react/index.ts";
import {
  WorkspaceFileReferencePickerFooter,
  WorkspaceFileReferencePickerPreviewPane
} from "./WorkspaceFileReferencePickerSections.tsx";
import { WorkspaceFileReferencePickerBrowserPane } from "./WorkspaceFileReferencePickerTree.tsx";

export interface WorkspaceFileReferencePickerProps {
  copy: WorkspaceFileReferenceCopy;
  fileAdapter?: WorkspaceFileReferenceAdapter;
  initialPath?: string | null;
  onClose: () => void;
  onConfirm: (refs: WorkspaceFileReference[]) => void;
  open: boolean;
  /**
   * When true, the dialog is rendered inline (non-portaled, absolutely
   * positioned) so it stays clipped within the nearest positioned ancestor —
   * e.g. an agent GUI node window — instead of covering the whole viewport.
   * Defaults to false (portal to body + cover the viewport).
   */
  scoped?: boolean;
  workspaceId: string;
}

export function WorkspaceFileReferencePicker({
  copy,
  fileAdapter,
  initialPath,
  onClose,
  onConfirm,
  open,
  scoped = false,
  workspaceId
}: WorkspaceFileReferencePickerProps) {
  const {
    browseRootEntries,
    directoryStateByPath,
    expandedFolderPaths,
    focusedEntry,
    focusedPath,
    isLoading,
    mode,
    previewState,
    searchQuery,
    selectedRefs,
    visibleEntries,
    setFocusedPath,
    setSearchQuery,
    toggleFolder,
    toggleRef
  } = useWorkspaceFileReferencePickerView({
    fileAdapter,
    initialPath,
    onClose,
    onConfirm,
    open,
    workspaceId
  });
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleEscapeKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", handleEscapeKeyDown, {
      capture: true
    });
    return () => {
      document.removeEventListener("keydown", handleEscapeKeyDown, {
        capture: true
      });
    };
  }, [onClose, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
    >
      <DialogContent
        // Radix infers the description; this picker has none.
        aria-describedby={undefined}
        className={cn(
          "nodrag flex h-[min(88vh,44rem)] w-full max-w-5xl flex-col gap-0 overflow-hidden border-[var(--line-1)] bg-[var(--background-fronted)] p-0 text-[var(--text-primary)] shadow-panel [-webkit-app-region:no-drag] sm:h-[min(82vh,44rem)] sm:max-w-5xl"
        )}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        // When scoped, both overlay and content stay clipped within the nearest
        // positioned ancestor (the node window) instead of covering the viewport.
        overlayClassName={cn("nodrag", scoped && "!absolute")}
        portaled={!scoped}
      >
        <DialogHeader className="flex-none border-b border-[var(--line-1)] px-4 py-4 sm:px-6 sm:py-5">
          <DialogTitle>{copy.t("referencePicker.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] lg:grid-rows-1">
          <WorkspaceFileReferencePickerBrowserPane
            browseRootEntries={browseRootEntries}
            copy={copy}
            directoryStateByPath={directoryStateByPath}
            expandedFolderPaths={expandedFolderPaths}
            focusedPath={focusedPath}
            isLoading={isLoading}
            mode={mode}
            searchQuery={searchQuery}
            selectedRefs={selectedRefs}
            setSearchQuery={setSearchQuery}
            visibleEntries={visibleEntries}
            onFocusPath={setFocusedPath}
            onToggleFolder={toggleFolder}
            onToggleRef={toggleRef}
          />
          <WorkspaceFileReferencePickerPreviewPane
            copy={copy}
            focusedEntry={focusedEntry}
            mode={mode}
            previewState={previewState}
          />
        </div>
        <WorkspaceFileReferencePickerFooter
          copy={copy}
          onClose={onClose}
          onConfirm={() => onConfirm(selectedRefs)}
          selectedRefs={selectedRefs}
        />
      </DialogContent>
    </Dialog>
  );
}
