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
  const folderMatchesByKey = new Map<string, Promise<boolean>>();
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

  const filterFolder = (folder: ReferenceNode): Promise<boolean> => {
    const key = nodeRefKey(folder.ref);
    const existing = folderMatchesByKey.get(key);
    if (existing) {
      return existing;
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
        return false;
      }
      const retained = await filterEntries(entries);
      childrenByKey[key] = loadedChildrenState(retained);
      return retained.length > 0;
    })();
    folderMatchesByKey.set(key, pending);
    return pending;
  };

  const filterEntries = async (
    entries: readonly ReferenceNode[]
  ): Promise<ReferenceNode[]> => {
    const retained = await Promise.all(
      entries.map(async (entry) => {
        if (entry.kind === "folder") {
          return (await filterFolder(entry)) ? entry : null;
        }
        return matchesFilterCategories(entry.displayName, false, input.filters)
          ? entry
          : null;
      })
    );
    return retained.filter((entry): entry is ReferenceNode => entry !== null);
  };

  const rootRef = {
    sourceId: input.sourceId,
    nodeId: SOURCE_ROOT_NODE_ID
  };
  const rootEntries = await runListTask(() => loadAllChildren(rootRef));
  childrenByKey[ROOT_CHILDREN_KEY] = loadedChildrenState(
    await filterEntries(rootEntries)
  );
  throwIfAborted(input.signal);
  return { childrenByKey };
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
