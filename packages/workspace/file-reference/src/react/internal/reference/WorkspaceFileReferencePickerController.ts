import { proxy } from "valtio/vanilla";
import {
  createWorkspaceFilePreviewController,
  type WorkspaceFilePreviewControllerState,
  type WorkspaceFilePreviewKind,
  type WorkspaceFilePreviewReadonlyReason
} from "@tutti-os/workspace-file-preview";
import type {
  WorkspaceFileReference,
  WorkspaceFileReferenceAdapter
} from "../../../contracts/index.ts";
import { uniqueWorkspaceFileReferences } from "../../../core/index.ts";
import {
  createWorkspaceFileReferenceDirectoryStateFromSnapshot,
  normalizeDirectoryPath,
  type WorkspaceFileReferenceDirectoryState
} from "./WorkspaceFileReferencePickerState.ts";

export type WorkspaceFileReferencePickerMode = "browse" | "search";

export type WorkspaceFileReferencePreviewState =
  | { status: "directory"; reference: WorkspaceFileReference }
  | { status: "empty" }
  | { status: "error"; reference: WorkspaceFileReference }
  | {
      status: "image";
      objectUrl: string;
      previewKind: "image";
      reference: WorkspaceFileReference;
    }
  | {
      previewKind?: WorkspaceFilePreviewKind;
      reference: WorkspaceFileReference;
      status: "loading";
    }
  | {
      status: "video";
      objectUrl: string;
      previewKind: "video";
      reference: WorkspaceFileReference;
    }
  | {
      maxSizeBytes?: number;
      reason: WorkspaceFilePreviewReadonlyReason;
      reference: WorkspaceFileReference;
      status: "readonly";
    }
  | {
      status: "text";
      content: string;
      previewKind: WorkspaceFilePreviewKind;
      reference: WorkspaceFileReference;
    }
  | { status: "unsupported"; reference: WorkspaceFileReference }
  | { status: "unavailable"; reference: WorkspaceFileReference };

export interface WorkspaceFileReferencePickerControllerSnapshot {
  browseError: Error | null;
  browseRootPath: string | null;
  directoryStateByPath: Record<string, WorkspaceFileReferenceDirectoryState>;
  expandedFolderPaths: Record<string, boolean>;
  initialPathRevealed: boolean;
  isBrowseLoading: boolean;
  isSearchLoading: boolean;
  mode: WorkspaceFileReferencePickerMode;
  previewState: WorkspaceFileReferencePreviewState;
  searchEntries: WorkspaceFileReference[];
  searchError: Error | null;
  searchQuery: string;
}

export interface CreateWorkspaceFileReferencePickerControllerInput {
  fileAdapter?: WorkspaceFileReferenceAdapter;
  searchDebounceMs?: number;
  workspaceId: string;
}

export interface WorkspaceFileReferencePickerController {
  close(): void;
  getSnapshot(): WorkspaceFileReferencePickerControllerSnapshot;
  loadBrowseRoot(): void;
  open(): void;
  reset(): void;
  revealInitialPath(initialDirectoryPath: string): Promise<string | null>;
  setPreviewReference(reference: WorkspaceFileReference | null): void;
  setSearchQuery(query: string): void;
  readonly store: WorkspaceFileReferencePickerControllerSnapshot;
  toggleFolder(entry: WorkspaceFileReference): void;
}

const defaultDirectoryPath = "/";
const defaultSearchDebounceMs = 180;

export function createWorkspaceFileReferencePickerController(
  input: CreateWorkspaceFileReferencePickerControllerInput
): WorkspaceFileReferencePickerController {
  const searchDebounceMs = input.searchDebounceMs ?? defaultSearchDebounceMs;
  // 浏览取数按 key 隔离失效:全局单调 ticket(nextBrowseSeq,永不回退/复用)派发,
  // latestBrowseSeqByKey 记录每个目录(及 reveal 批量)的最新 ticket。取数 resolve 时凭
  // 自身 ticket 是否仍为该 key 的最新值判定是否落库 —— 不同目录的并发取数互不作废
  // (否则全局单计数会让后发取数把先发的另一目录取数结果静默丢弃、令其 loading 永不
  // 清除)。cancelCurrentBrowse 清空该表使全部在途浏览取数失效。
  let nextBrowseSeq = 0;
  const latestBrowseSeqByKey = new Map<string, number>();
  const stampBrowse = (seqKey: string): number => {
    const sequence = ++nextBrowseSeq;
    latestBrowseSeqByKey.set(seqKey, sequence);
    return sequence;
  };
  const isBrowseStale = (seqKey: string, sequence: number): boolean =>
    !retained || latestBrowseSeqByKey.get(seqKey) !== sequence;
  /** reveal 批量加载用的固定 seq key(不与单目录 key 冲突)。 */
  const REVEAL_SEQ_KEY = "\0reveal";
  let retained = false;
  let searchAbortController: AbortController | null = null;
  let searchSequence = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: WorkspaceFileReferencePickerControllerSnapshot = {
    browseError: null,
    browseRootPath: null,
    directoryStateByPath: {},
    expandedFolderPaths: {},
    initialPathRevealed: false,
    isBrowseLoading: false,
    isSearchLoading: false,
    mode: "browse",
    previewState: { status: "empty" },
    searchEntries: [],
    searchError: null,
    searchQuery: ""
  };
  const store = proxy(snapshot);

  const setSnapshot = (
    update:
      | Partial<WorkspaceFileReferencePickerControllerSnapshot>
      | ((
          current: WorkspaceFileReferencePickerControllerSnapshot
        ) => WorkspaceFileReferencePickerControllerSnapshot)
  ) => {
    const next =
      typeof update === "function"
        ? update(snapshot)
        : { ...snapshot, ...update };
    if (next === snapshot) {
      return;
    }
    snapshot = next;
    Object.assign(store, next);
  };

  const previewController = createWorkspaceFilePreviewController({
    read: input.fileAdapter?.readReferencePreview
      ? async ({ entry }) => {
          const preview = await input.fileAdapter!.readReferencePreview!({
            reference: entry,
            workspaceId: input.workspaceId
          });
          return preview
            ? {
                bytes: preview.bytes,
                contentType: preview.contentType,
                kind: preview.kind
              }
            : null;
        }
      : undefined,
    toPreviewEntry: (reference: WorkspaceFileReference) => reference
  });
  previewController.subscribe(() => {
    setSnapshot({
      previewState: projectReferencePreviewState(
        previewController.getSnapshot()
      )
    });
  });

  const loadDirectoryListing = async (path?: string | null) => {
    if (!input.fileAdapter?.listDirectory) {
      return null;
    }
    const listing = await input.fileAdapter.listDirectory({
      path: path ?? undefined,
      workspaceId: input.workspaceId
    });
    const displayPath =
      listing.directoryPath || listing.rootPath || path || defaultDirectoryPath;
    const normalizedPath = normalizeDirectoryPath(displayPath);

    return {
      displayPath,
      entries: uniqueWorkspaceFileReferences(listing.entries),
      normalizedPath
    };
  };

  const resolveMode = (query: string) =>
    query.trim().length > 0 && input.fileAdapter?.searchReferences
      ? "search"
      : "browse";

  const clearSearchTimer = () => {
    if (searchTimer === null) {
      return;
    }
    clearTimeout(searchTimer);
    searchTimer = null;
  };

  const cancelCurrentSearch = () => {
    clearSearchTimer();
    searchSequence += 1;
    searchAbortController?.abort();
    searchAbortController = null;
  };

  const cancelCurrentBrowse = () => {
    // 清空 ticket 表:在途取数 resolve 时其 key 已无最新 ticket(get→undefined),被丢弃。
    latestBrowseSeqByKey.clear();
  };

  const clearSearchResults = () => {
    cancelCurrentSearch();
    setSnapshot({
      isSearchLoading: false,
      searchEntries: [],
      searchError: null
    });
  };

  const runSearch = async (query: string) => {
    if (!retained || !input.fileAdapter?.searchReferences) {
      return;
    }

    const sequence = ++searchSequence;
    searchAbortController?.abort();
    const abortController = new AbortController();
    searchAbortController = abortController;
    setSnapshot({
      isSearchLoading: true,
      searchError: null
    });

    try {
      const refs = await input.fileAdapter.searchReferences({
        query,
        signal: abortController.signal,
        workspaceId: input.workspaceId
      });
      if (!retained || sequence !== searchSequence) {
        return;
      }
      setSnapshot({
        isSearchLoading: false,
        searchEntries: uniqueWorkspaceFileReferences(refs),
        searchError: null
      });
    } catch (error) {
      if (isAbortError(error) || sequence !== searchSequence || !retained) {
        return;
      }
      setSnapshot({
        isSearchLoading: false,
        searchEntries: [],
        searchError: normalizeControllerError(
          error,
          "Workspace file reference search failed"
        )
      });
    } finally {
      if (sequence === searchSequence) {
        searchAbortController = null;
      }
    }
  };

  const scheduleSearch = () => {
    clearSearchTimer();
    const query = snapshot.searchQuery.trim();
    if (!retained || !input.fileAdapter?.searchReferences || !query) {
      clearSearchResults();
      return;
    }

    if (searchDebounceMs <= 0) {
      void runSearch(query);
      return;
    }

    searchTimer = setTimeout(() => {
      searchTimer = null;
      void runSearch(query);
    }, searchDebounceMs);
  };

  const loadBrowseRoot = async () => {
    if (
      !retained ||
      snapshot.mode !== "browse" ||
      !(
        input.fileAdapter?.listDirectory || input.fileAdapter?.loadReferenceTree
      )
    ) {
      return;
    }
    const activeBrowseRootPath = snapshot.browseRootPath;
    const normalizedRoot = activeBrowseRootPath
      ? normalizeDirectoryPath(activeBrowseRootPath)
      : null;
    if (
      normalizedRoot &&
      snapshot.directoryStateByPath[normalizedRoot]?.loaded
    ) {
      return;
    }

    const seqKey = normalizedRoot ?? "";
    const sequence = stampBrowse(seqKey);
    setSnapshot({
      browseError: null,
      isBrowseLoading: true
    });

    try {
      if (input.fileAdapter.loadReferenceTree) {
        const treeSnapshot = await input.fileAdapter.loadReferenceTree({
          path: activeBrowseRootPath ?? undefined,
          prefetchBudgetMs: 500,
          prefetchDepth: 4,
          workspaceId: input.workspaceId
        });
        if (isBrowseStale(seqKey, sequence)) {
          return;
        }
        setSnapshot({
          browseRootPath: normalizeDirectoryPath(
            treeSnapshot.directory.directoryPath
          ),
          directoryStateByPath:
            createWorkspaceFileReferenceDirectoryStateFromSnapshot(
              treeSnapshot
            ),
          isBrowseLoading: false
        });
        return;
      }

      const listing = await loadDirectoryListing(activeBrowseRootPath);
      if (isBrowseStale(seqKey, sequence) || !listing) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        browseRootPath: listing.normalizedPath,
        directoryStateByPath: {
          ...current.directoryStateByPath,
          [listing.normalizedPath]: {
            displayPath: listing.displayPath,
            entries: listing.entries,
            loaded: true,
            loading: false
          }
        },
        isBrowseLoading: false
      }));
    } catch (error) {
      if (isBrowseStale(seqKey, sequence)) {
        return;
      }
      setSnapshot({
        browseError: normalizeControllerError(
          error,
          "Workspace file reference browse failed"
        ),
        isBrowseLoading: false
      });
    }
  };

  const loadFolderChildren = async (folder: WorkspaceFileReference) => {
    const folderKey = normalizeDirectoryPath(folder.path);
    if (
      !retained ||
      snapshot.directoryStateByPath[folderKey]?.loaded ||
      snapshot.directoryStateByPath[folderKey]?.loading
    ) {
      return;
    }

    const sequence = stampBrowse(folderKey);
    setSnapshot((current) => ({
      ...current,
      directoryStateByPath: {
        ...current.directoryStateByPath,
        [folderKey]: {
          displayPath: folder.path,
          entries: current.directoryStateByPath[folderKey]?.entries ?? [],
          loaded: current.directoryStateByPath[folderKey]?.loaded ?? false,
          loading: true
        }
      }
    }));

    try {
      const listing = await loadDirectoryListing(folderKey);
      if (isBrowseStale(folderKey, sequence) || !listing) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        directoryStateByPath: {
          ...current.directoryStateByPath,
          [folderKey]: {
            displayPath: listing.displayPath,
            entries: listing.entries,
            loaded: true,
            loading: false
          }
        }
      }));
    } catch {
      if (isBrowseStale(folderKey, sequence)) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        directoryStateByPath: {
          ...current.directoryStateByPath,
          [folderKey]: {
            displayPath:
              current.directoryStateByPath[folderKey]?.displayPath ??
              folder.path,
            entries: current.directoryStateByPath[folderKey]?.entries ?? [],
            loaded: current.directoryStateByPath[folderKey]?.loaded ?? false,
            loading: false
          }
        }
      }));
    }
  };

  const setPreviewReference = (reference: WorkspaceFileReference | null) => {
    if (!retained || !reference) {
      void previewController.setEntry(null);
      return;
    }
    void previewController.setEntry(reference);
  };

  return {
    close() {
      retained = false;
      cancelCurrentBrowse();
      void previewController.setEntry(null);
      cancelCurrentSearch();
      setSnapshot({
        isBrowseLoading: false,
        isSearchLoading: false,
        previewState: { status: "empty" }
      });
    },
    getSnapshot() {
      return snapshot;
    },
    loadBrowseRoot() {
      void loadBrowseRoot();
    },
    open() {
      if (retained) {
        return;
      }
      retained = true;
      if (snapshot.mode === "search") {
        scheduleSearch();
        return;
      }
      void loadBrowseRoot();
    },
    async revealInitialPath(initialDirectoryPath) {
      if (
        !retained ||
        snapshot.mode !== "browse" ||
        snapshot.initialPathRevealed ||
        !snapshot.browseRootPath
      ) {
        return null;
      }

      const rootPath = normalizeDirectoryPath(snapshot.browseRootPath);
      if (!isPathInsideOrEqual(initialDirectoryPath, rootPath)) {
        setSnapshot({
          initialPathRevealed: true
        });
        return null;
      }

      const sequence = stampBrowse(REVEAL_SEQ_KEY);
      const loadedDirectories: Record<
        string,
        WorkspaceFileReferenceDirectoryState
      > = {};
      const expandedDirectories: Record<string, boolean> = {};
      const directoryState = (path: string) =>
        loadedDirectories[path] ?? snapshot.directoryStateByPath[path];

      const directoryPaths = directoryChainBetween(
        rootPath,
        initialDirectoryPath
      );
      for (const directoryPath of directoryPaths) {
        expandedDirectories[directoryPath] = true;
      }

      const listings = await Promise.all(
        directoryPaths
          .filter((directoryPath) => !directoryState(directoryPath)?.loaded)
          .map(async (directoryPath) => {
            try {
              return await loadDirectoryListing(directoryPath);
            } catch {
              return null;
            }
          })
      );

      for (const listing of listings) {
        if (!listing) {
          continue;
        }
        loadedDirectories[listing.normalizedPath] = {
          displayPath: listing.displayPath,
          entries: listing.entries,
          loaded: true,
          loading: false
        };
      }

      if (isBrowseStale(REVEAL_SEQ_KEY, sequence)) {
        return null;
      }
      setSnapshot((current) => ({
        ...current,
        directoryStateByPath: {
          ...current.directoryStateByPath,
          ...loadedDirectories
        },
        expandedFolderPaths: {
          ...current.expandedFolderPaths,
          ...expandedDirectories
        },
        initialPathRevealed: true
      }));
      return initialDirectoryPath;
    },
    reset() {
      cancelCurrentBrowse();
      void previewController.setEntry(null);
      cancelCurrentSearch();
      setSnapshot({
        browseError: null,
        browseRootPath: null,
        directoryStateByPath: {},
        expandedFolderPaths: {},
        initialPathRevealed: false,
        isBrowseLoading: false,
        isSearchLoading: false,
        mode: "browse",
        previewState: { status: "empty" },
        searchEntries: [],
        searchError: null,
        searchQuery: ""
      });
    },
    setPreviewReference(reference) {
      setPreviewReference(reference);
    },
    setSearchQuery(query) {
      if (query === snapshot.searchQuery) {
        return;
      }
      const nextMode = resolveMode(query);
      setSnapshot({
        mode: nextMode,
        searchQuery: query,
        ...(nextMode === "browse" ? { isSearchLoading: false } : {})
      });
      if (nextMode === "search") {
        cancelCurrentBrowse();
        scheduleSearch();
        return;
      }
      clearSearchResults();
      void loadBrowseRoot();
    },
    get store() {
      return store;
    },
    toggleFolder(entry) {
      const folderKey = normalizeDirectoryPath(entry.path);
      const childState = snapshot.directoryStateByPath[folderKey];
      const nextExpanded = !(snapshot.expandedFolderPaths[folderKey] ?? false);

      setSnapshot((current) => ({
        ...current,
        expandedFolderPaths: {
          ...current.expandedFolderPaths,
          [folderKey]: nextExpanded
        }
      }));
      if (nextExpanded && !childState?.loaded && !childState?.loading) {
        void loadFolderChildren(entry);
      }
    }
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function normalizeControllerError(
  error: unknown,
  fallbackMessage: string
): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function projectReferencePreviewState(
  state: WorkspaceFilePreviewControllerState<WorkspaceFileReference>
): WorkspaceFileReferencePreviewState {
  switch (state.status) {
    case "empty":
      return state;
    case "directory":
      return { reference: state.entry, status: "directory" };
    case "loading":
      return {
        previewKind: state.previewKind,
        reference: state.entry,
        status: "loading"
      };
    case "text":
      return {
        content: state.content,
        previewKind: state.previewKind,
        reference: state.entry,
        status: "text"
      };
    case "image":
      return {
        objectUrl: state.objectUrl,
        previewKind: "image",
        reference: state.entry,
        status: "image"
      };
    case "video":
      return {
        objectUrl: state.objectUrl,
        previewKind: "video",
        reference: state.entry,
        status: "video"
      };
    case "bytes":
      return { reference: state.entry, status: "unsupported" };
    case "readonly":
      return {
        maxSizeBytes: state.maxSizeBytes,
        reason: state.reason,
        reference: state.entry,
        status: "readonly"
      };
    case "unsupported":
      return state.reason === "reader_unavailable"
        ? { reference: state.entry, status: "unavailable" }
        : { reference: state.entry, status: "unsupported" };
    case "error":
      return { reference: state.entry, status: "error" };
  }
}

function isPathInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = normalizeDirectoryPath(path);
  const normalizedRoot = normalizeDirectoryPath(root);
  if (normalizedRoot === "/") {
    return normalizedPath.startsWith("/");
  }
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function directoryChainBetween(root: string, target: string): string[] {
  const normalizedRoot = normalizeDirectoryPath(root);
  let current = normalizeDirectoryPath(target);
  const chain: string[] = [];

  while (current && current !== normalizedRoot) {
    chain.unshift(current);
    const parent = dirnameDirectoryPath(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return chain;
}

function dirnameDirectoryPath(path: string): string {
  const normalized = normalizeDirectoryPath(path);
  if (normalized === "/") {
    return "/";
  }
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}
