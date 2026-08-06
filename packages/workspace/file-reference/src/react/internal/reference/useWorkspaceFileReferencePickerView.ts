import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "valtio";
import type {
  WorkspaceFileReferenceAdapter,
  WorkspaceFileReference
} from "../../../contracts/index.ts";
import { uniqueWorkspaceFileReferences } from "../../../core/index.ts";
import {
  collectVisibleTreeEntries,
  normalizeDirectoryPath
} from "./WorkspaceFileReferencePickerState.ts";
import {
  createWorkspaceFileReferencePickerController,
  type WorkspaceFileReferencePreviewState
} from "./WorkspaceFileReferencePickerController.ts";

export type { WorkspaceFileReferencePreviewState };

export interface UseWorkspaceFileReferencePickerViewInput {
  fileAdapter?: WorkspaceFileReferenceAdapter;
  initialPath?: string | null;
  onClose: () => void;
  onConfirm: (refs: WorkspaceFileReference[]) => void;
  open: boolean;
  workspaceId: string;
}

export function useWorkspaceFileReferencePickerView({
  fileAdapter,
  initialPath,
  onClose,
  onConfirm,
  open,
  workspaceId
}: UseWorkspaceFileReferencePickerViewInput) {
  const readPickerSnapshot = useSnapshot as <T extends object>(store: T) => T;
  const trimmedInitialPath = initialPath?.trim() ?? "";
  const initialDirectoryPath = trimmedInitialPath
    ? normalizeDirectoryPath(trimmedInitialPath)
    : null;
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [selectedRefs, setSelectedRefs] = useState<WorkspaceFileReference[]>(
    []
  );

  const pickerController = useMemo(
    () =>
      createWorkspaceFileReferencePickerController({
        fileAdapter,
        workspaceId
      }),
    [fileAdapter, workspaceId]
  );
  const pickerSnapshot = readPickerSnapshot(pickerController.store);
  const {
    browseRootPath,
    directoryStateByPath,
    expandedFolderPaths,
    isBrowseLoading,
    isSearchLoading,
    mode,
    previewState,
    searchEntries,
    searchQuery
  } = pickerSnapshot;
  const isLoading = mode === "search" ? isSearchLoading : isBrowseLoading;

  const onCloseRef = useRef(onClose);
  const onConfirmRef = useRef(onConfirm);
  onCloseRef.current = onClose;
  onConfirmRef.current = onConfirm;
  const finalizeRequestedReferences = useCallback(
    (refs: WorkspaceFileReference[]) => {
      onConfirmRef.current(uniqueWorkspaceFileReferences(refs));
      onCloseRef.current();
    },
    []
  );

  const setSearchQuery = useCallback(
    (query: string) => {
      pickerController.setSearchQuery(query);
    },
    [pickerController]
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    pickerController.reset();
    pickerController.open();
    setFocusedPath(null);
    setSelectedRefs([]);
    return () => {
      pickerController.close();
    };
  }, [initialDirectoryPath, open, pickerController]);

  useEffect(() => {
    if (!open || mode !== "browse") {
      return;
    }
    pickerController.loadBrowseRoot();
  }, [mode, open, pickerController]);

  useEffect(() => {
    if (!open || !fileAdapter || mode !== "browse") {
      return;
    }
    if (
      fileAdapter.listDirectory ||
      fileAdapter.loadReferenceTree ||
      !fileAdapter.requestReferences
    ) {
      return;
    }
    let canceled = false;
    void fileAdapter.requestReferences({ workspaceId }).then((refs) => {
      if (!canceled) {
        finalizeRequestedReferences(refs);
      }
    });
    return () => {
      canceled = true;
    };
  }, [fileAdapter, finalizeRequestedReferences, mode, open, workspaceId]);

  useEffect(() => {
    if (
      !open ||
      mode !== "browse" ||
      pickerSnapshot.initialPathRevealed ||
      !initialDirectoryPath ||
      !browseRootPath
    ) {
      return;
    }

    let canceled = false;
    const reveal = async () => {
      const focusedInitialPath =
        await pickerController.revealInitialPath(initialDirectoryPath);
      if (!canceled && focusedInitialPath) {
        setFocusedPath(focusedInitialPath);
      }
    };

    void reveal();
    return () => {
      canceled = true;
    };
  }, [
    browseRootPath,
    initialDirectoryPath,
    mode,
    open,
    pickerController,
    pickerSnapshot.initialPathRevealed
  ]);

  const browseRootEntries = useMemo(
    () =>
      browseRootPath
        ? (directoryStateByPath[normalizeDirectoryPath(browseRootPath)]
            ?.entries ?? [])
        : [],
    [browseRootPath, directoryStateByPath]
  );

  const visibleEntries = useMemo(
    () =>
      mode === "search"
        ? searchEntries
        : collectVisibleTreeEntries(
            browseRootEntries,
            directoryStateByPath,
            expandedFolderPaths
          ),
    [
      browseRootEntries,
      directoryStateByPath,
      expandedFolderPaths,
      mode,
      searchEntries
    ]
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setFocusedPath((current) => {
      if (current && visibleEntries.some((entry) => entry.path === current)) {
        return current;
      }
      return visibleEntries[0]?.path ?? null;
    });
  }, [open, visibleEntries]);

  const focusedEntry =
    visibleEntries.find((entry) => entry.path === focusedPath) ??
    selectedRefs.find((entry) => entry.path === focusedPath) ??
    null;

  useEffect(() => {
    pickerController.setPreviewReference(open ? focusedEntry : null);
  }, [focusedEntry, open, pickerController]);

  const toggleRef = (ref: WorkspaceFileReference) => {
    setSelectedRefs((current) => {
      const existing = current.some((item) => item.path === ref.path);
      return existing
        ? current.filter((item) => item.path !== ref.path)
        : uniqueWorkspaceFileReferences([...current, ref]);
    });
  };

  const toggleFolder = (entry: WorkspaceFileReference) => {
    pickerController.toggleFolder(entry);
  };

  return {
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
  };
}
