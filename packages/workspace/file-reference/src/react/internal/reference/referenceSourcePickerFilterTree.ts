import type {
  NodeRef,
  ReferenceNode,
  ReferenceScope
} from "../../../contracts/referenceSource.ts";
import {
  SOURCE_ROOT_NODE_ID,
  type ReferenceSourceAggregator
} from "../../../core/referenceSourceAggregator.ts";
import { matchesFilterCategories, nodeRefKey } from "../../../core/index.ts";
import {
  ROOT_CHILDREN_KEY,
  type ReferenceSourceNodeChildrenState
} from "./referenceSourcePickerController.ts";

const FILTER_TREE_LIST_CONCURRENCY = 8;

export interface ReferenceSourcePickerFilteredTree {
  childrenByKey: Record<string, ReferenceSourceNodeChildrenState>;
}

export async function buildReferenceSourcePickerFilteredTree(input: {
  aggregator: ReferenceSourceAggregator;
  filters: readonly string[];
  scope: ReferenceScope;
  signal: AbortSignal;
  sourceId: string;
}): Promise<ReferenceSourcePickerFilteredTree> {
  const childrenByKey: Record<string, ReferenceSourceNodeChildrenState> = {};
  const folderEntriesByKey = new Map<string, ReferenceNode[]>();
  const folderLoadsByKey = new Map<string, Promise<void>>();
  const runListTask = createAsyncTaskLimiter(FILTER_TREE_LIST_CONCURRENCY);

  const loadAllChildren = async (node: NodeRef): Promise<ReferenceNode[]> => {
    const entriesByKey = new Map<string, ReferenceNode>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      throwIfAborted(input.signal);
      const page = await input.aggregator.listChildren(input.scope, node, {
        cursor,
        signal: input.signal
      });
      for (const entry of page.entries) {
        entriesByKey.set(nodeRefKey(entry.ref), entry);
      }
      cursor = page.nextCursor ?? null;
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error("reference source repeated a filter-tree cursor");
        }
        seenCursors.add(cursor);
      }
    } while (cursor);
    return [...entriesByKey.values()];
  };

  const scheduleFolderLoad = (folder: ReferenceNode): void => {
    const key = nodeRefKey(folder.ref);
    if (folderLoadsByKey.has(key)) {
      return;
    }
    const pending = (async () => {
      let entries: ReferenceNode[];
      try {
        entries = await runListTask(() => loadAllChildren(folder.ref));
      } catch (error) {
        if (input.signal.aborted || isAbortError(error)) {
          throw error;
        }
        childrenByKey[key] = failedChildrenState(error);
        return;
      }
      folderEntriesByKey.set(key, entries);
      for (const entry of entries) {
        if (entry.kind === "folder") {
          scheduleFolderLoad(entry);
        }
      }
    })();
    folderLoadsByKey.set(key, pending);
  };

  const rootRef = {
    sourceId: input.sourceId,
    nodeId: SOURCE_ROOT_NODE_ID
  };
  const rootEntries = await runListTask(() => loadAllChildren(rootRef));
  for (const entry of rootEntries) {
    if (entry.kind === "folder") {
      scheduleFolderLoad(entry);
    }
  }
  let awaitedLoadCount = 0;
  while (awaitedLoadCount < folderLoadsByKey.size) {
    const pendingLoads = [...folderLoadsByKey.values()].slice(awaitedLoadCount);
    awaitedLoadCount += pendingLoads.length;
    await Promise.all(pendingLoads);
  }

  const matchingFolderKeys = findFoldersWithMatchingDescendants(
    folderEntriesByKey,
    input.filters
  );
  for (const [key, entries] of folderEntriesByKey) {
    childrenByKey[key] = loadedChildrenState(
      filterEntries(entries, matchingFolderKeys, input.filters)
    );
  }
  childrenByKey[ROOT_CHILDREN_KEY] = loadedChildrenState(
    filterEntries(rootEntries, matchingFolderKeys, input.filters)
  );
  throwIfAborted(input.signal);
  return { childrenByKey };
}

function findFoldersWithMatchingDescendants(
  folderEntriesByKey: ReadonlyMap<string, readonly ReferenceNode[]>,
  filters: readonly string[]
): ReadonlySet<string> {
  const matchingFolderKeys = new Set<string>();
  const parentKeysByChildKey = new Map<string, Set<string>>();
  const pendingKeys: string[] = [];

  for (const [parentKey, entries] of folderEntriesByKey) {
    for (const entry of entries) {
      if (entry.kind === "folder") {
        const childKey = nodeRefKey(entry.ref);
        const parentKeys = parentKeysByChildKey.get(childKey) ?? new Set();
        parentKeys.add(parentKey);
        parentKeysByChildKey.set(childKey, parentKeys);
      } else if (
        !matchingFolderKeys.has(parentKey) &&
        matchesFilterCategories(entry.displayName, false, filters)
      ) {
        matchingFolderKeys.add(parentKey);
        pendingKeys.push(parentKey);
      }
    }
  }

  for (let index = 0; index < pendingKeys.length; index += 1) {
    const childKey = pendingKeys[index];
    if (!childKey) {
      continue;
    }
    for (const parentKey of parentKeysByChildKey.get(childKey) ?? []) {
      if (matchingFolderKeys.has(parentKey)) {
        continue;
      }
      matchingFolderKeys.add(parentKey);
      pendingKeys.push(parentKey);
    }
  }
  return matchingFolderKeys;
}

function filterEntries(
  entries: readonly ReferenceNode[],
  matchingFolderKeys: ReadonlySet<string>,
  filters: readonly string[]
): ReferenceNode[] {
  return entries.filter((entry) =>
    entry.kind === "folder"
      ? matchingFolderKeys.has(nodeRefKey(entry.ref))
      : matchesFilterCategories(entry.displayName, false, filters)
  );
}

function loadedChildrenState(
  entries: ReferenceNode[]
): ReferenceSourceNodeChildrenState {
  return {
    entries,
    error: null,
    loaded: true,
    loading: false,
    nextCursor: null
  };
}

function failedChildrenState(error: unknown): ReferenceSourceNodeChildrenState {
  return {
    entries: [],
    error: error instanceof Error ? error : new Error(String(error)),
    loaded: false,
    loading: false,
    nextCursor: null
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAsyncTaskLimiter(concurrency: number) {
  let activeCount = 0;
  const waiters: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (activeCount < concurrency) {
      activeCount += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    activeCount += 1;
  };

  const release = (): void => {
    activeCount -= 1;
    waiters.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("reference filter tree aborted");
    error.name = "AbortError";
    throw error;
  }
}
