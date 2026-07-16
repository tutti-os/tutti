import type { AgentMentionProviderQueryDiagnostic } from "./agentMentionSearchDiagnostics";
import type {
  AgentMentionFilterId,
  AgentMentionIssueTopicGroup,
  AgentMentionLifecycleDiagnosticLog,
  AgentMentionRawGroups,
  AgentMentionTotalCounts
} from "./AgentMentionSearchContracts";
import {
  elapsedDiagnosticMs,
  providerDiagnosticsSummary,
  rawGroupItemCount
} from "./AgentMentionSearchModel";

export interface AgentMentionBrowseFetchResult {
  providerDiagnostics: AgentMentionProviderQueryDiagnostic[];
  rawGroups: AgentMentionRawGroups;
  totalCounts: AgentMentionTotalCounts;
  issueTopicGroups: AgentMentionIssueTopicGroup[] | null;
}

export interface AgentMentionBrowseCacheEntry extends AgentMentionBrowseFetchResult {
  cachedAt: number;
}

export type AgentMentionBrowseLoadReason = "open" | "preload";

const sharedAgentMentionBrowseCache = new Map<
  string,
  AgentMentionBrowseCacheEntry
>();
interface SharedAgentMentionBrowseFetch {
  abortController: AbortController;
  consumers: Set<symbol>;
  promise: Promise<AgentMentionBrowseFetchResult> | null;
  settled: boolean;
}

const sharedAgentMentionBrowseFetches = new Map<
  string,
  SharedAgentMentionBrowseFetch
>();

// Bound the shared browse cache so long-lived renderer sessions cannot grow it
// without limit. Eviction happens on write (LRU-by-insertion-order); reads keep
// returning stale entries so the stale-while-revalidate path stays intact.
export const MAX_BROWSE_CACHE_ENTRIES = 64;

function writeBrowseCacheEntry(
  cacheKey: string,
  entry: AgentMentionBrowseCacheEntry
): void {
  // Re-insert so the freshly written key becomes the newest (Map preserves
  // insertion order), then drop the oldest keys past the cap.
  sharedAgentMentionBrowseCache.delete(cacheKey);
  sharedAgentMentionBrowseCache.set(cacheKey, entry);
  while (sharedAgentMentionBrowseCache.size > MAX_BROWSE_CACHE_ENTRIES) {
    const oldestKey = sharedAgentMentionBrowseCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    sharedAgentMentionBrowseCache.delete(oldestKey);
  }
}

export function mergeAgentMentionBrowseIssueGroupPage(input: {
  cacheKey: string;
  group: AgentMentionIssueTopicGroup;
  cachedAt: number;
}): void {
  const entry = sharedAgentMentionBrowseCache.get(input.cacheKey);
  if (!entry?.issueTopicGroups) {
    return;
  }
  const groupIndex = entry.issueTopicGroups.findIndex(
    (group) => group.id === input.group.id
  );
  if (groupIndex < 0) {
    return;
  }
  const previous = entry.issueTopicGroups[groupIndex];
  if (!previous) {
    return;
  }
  const seen = new Set(
    previous.items
      .filter((item) => item.kind === "workspace-issue")
      .map((item) => item.targetId)
  );
  const appended = input.group.items.filter((item) => {
    if (item.kind !== "workspace-issue") {
      return true;
    }
    if (seen.has(item.targetId)) {
      return false;
    }
    seen.add(item.targetId);
    return true;
  });
  const mergedItems = [...previous.items, ...appended];
  const groups = entry.issueTopicGroups.map((group, index) =>
    index === groupIndex
      ? {
          ...previous,
          items: mergedItems,
          totalCount: Math.max(input.group.totalCount, mergedItems.length),
          nextPageToken: input.group.nextPageToken,
          loadMoreStatus: "idle" as const,
          loadMoreError: null
        }
      : group
  );
  writeBrowseCacheEntry(input.cacheKey, {
    ...entry,
    issueTopicGroups: groups,
    cachedAt: input.cachedAt
  });
}

// Defer speculative warm-up to a browser idle slot so it never blocks the
// caller's synchronous path (e.g. a composer focus handler) or a render commit.
// Falls back to a macrotask where requestIdleCallback is unavailable (jsdom,
// older runtimes). Returns a canceller the owner uses on teardown.
export function scheduleAgentMentionIdleTask(task: () => void): () => void {
  const scope = globalThis as typeof globalThis & {
    requestIdleCallback?: (
      cb: () => void,
      opts?: { timeout: number }
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof scope.requestIdleCallback === "function") {
    const handle = scope.requestIdleCallback(() => task(), { timeout: 500 });
    return () => scope.cancelIdleCallback?.(handle);
  }
  // timing: requestIdleCallback fallback for runtimes that lack it; run on next tick
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}

export function resetAgentMentionSearchBrowseCacheForTests(): void {
  sharedAgentMentionBrowseCache.clear();
  for (const fetch of sharedAgentMentionBrowseFetches.values()) {
    fetch.abortController.abort();
  }
  sharedAgentMentionBrowseFetches.clear();
}

(
  globalThis as typeof globalThis & {
    __tuttiResetAgentMentionSearchBrowseCacheForTests?: () => void;
  }
).__tuttiResetAgentMentionSearchBrowseCacheForTests =
  resetAgentMentionSearchBrowseCacheForTests;

// Resolve filter tab labels lazily so they reflect the active i18n locale at the
// time a state is emitted. Computing this at module load froze the labels to the

export async function loadAgentMentionBrowseFetchResult(input: {
  input: {
    workspaceId: string;
    currentUserId: string;
    filter: AgentMentionFilterId;
    sessionCwd: string;
    sectionKey: string;
  };
  cacheKey: string;
  reason: AgentMentionBrowseLoadReason;
  diagnosticNow: () => number;
  providerIds: string;
  abortSignal?: AbortSignal;
  fetchBrowseResult: (
    abortSignal: AbortSignal
  ) => Promise<AgentMentionBrowseFetchResult>;
  logLifecycle: (
    event: AgentMentionLifecycleDiagnosticLog["event"],
    details: AgentMentionLifecycleDiagnosticLog["details"]
  ) => void;
}): Promise<AgentMentionBrowseFetchResult> {
  const { cacheKey, reason } = input;
  const browseInput = input.input;
  let sharedFetch = sharedAgentMentionBrowseFetches.get(cacheKey);
  if (sharedFetch) {
    input.logLifecycle("browse.fetch.dedupe", {
      filter: browseInput.filter,
      reason,
      workspaceId: browseInput.workspaceId
    });
  } else {
    const startedAt = input.diagnosticNow();
    input.logLifecycle("browse.fetch.start", {
      filter: browseInput.filter,
      providerIds: input.providerIds,
      reason,
      workspaceId: browseInput.workspaceId
    });
    const abortController = new AbortController();
    sharedFetch = {
      abortController,
      consumers: new Set(),
      promise: null,
      settled: false
    };
    const entry = sharedFetch;
    entry.promise = input
      .fetchBrowseResult(abortController.signal)
      .then((result) => {
        if (abortController.signal.aborted) {
          const error = new Error("Mention browse request aborted");
          error.name = "AbortError";
          throw error;
        }
        writeBrowseCacheEntry(cacheKey, {
          ...result,
          cachedAt: input.diagnosticNow()
        });
        input.logLifecycle("browse.fetch.success", {
          durationMs: elapsedDiagnosticMs(input.diagnosticNow(), startedAt),
          filter: browseInput.filter,
          itemCount: rawGroupItemCount(result.rawGroups),
          providerResults: providerDiagnosticsSummary(
            result.providerDiagnostics
          ),
          reason,
          workspaceId: browseInput.workspaceId
        });
        return result;
      })
      .finally(() => {
        entry.settled = true;
        if (sharedAgentMentionBrowseFetches.get(cacheKey) === entry) {
          sharedAgentMentionBrowseFetches.delete(cacheKey);
        }
      });
    sharedAgentMentionBrowseFetches.set(cacheKey, entry);
  }

  return consumeSharedBrowseFetch({
    abortSignal: input.abortSignal,
    cacheKey,
    sharedFetch
  });
}

function consumeSharedBrowseFetch(input: {
  abortSignal?: AbortSignal;
  cacheKey: string;
  sharedFetch: SharedAgentMentionBrowseFetch;
}): Promise<AgentMentionBrowseFetchResult> {
  const consumer = Symbol(input.cacheKey);
  input.sharedFetch.consumers.add(consumer);
  const sharedPromise = input.sharedFetch.promise;
  if (!sharedPromise) {
    input.sharedFetch.consumers.delete(consumer);
    return Promise.reject(new Error("Mention browse request was not started"));
  }

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (settle: () => void, abortWhenUnused: boolean): void => {
      if (finished) {
        return;
      }
      finished = true;
      input.abortSignal?.removeEventListener("abort", onAbort);
      input.sharedFetch.consumers.delete(consumer);
      if (
        abortWhenUnused &&
        !input.sharedFetch.settled &&
        input.sharedFetch.consumers.size === 0
      ) {
        if (
          sharedAgentMentionBrowseFetches.get(input.cacheKey) ===
          input.sharedFetch
        ) {
          sharedAgentMentionBrowseFetches.delete(input.cacheKey);
        }
        input.sharedFetch.abortController.abort();
      }
      settle();
    };
    const onAbort = (): void => {
      const error = new Error("Mention browse request aborted");
      error.name = "AbortError";
      finish(() => reject(error), true);
    };

    if (input.abortSignal?.aborted) {
      onAbort();
      return;
    }
    input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    sharedPromise.then(
      (result) => finish(() => resolve(result), false),
      (error: unknown) => finish(() => reject(error), false)
    );
  });
}

export function readAgentMentionBrowseCache(input: {
  cacheKey: string;
  browseCacheTtlMs: number;
  diagnosticNow: () => number;
}): {
  entry: AgentMentionBrowseCacheEntry | null;
  isFresh: boolean;
} {
  const entry = sharedAgentMentionBrowseCache.get(input.cacheKey);
  if (!entry) {
    return { entry: null, isFresh: false };
  }
  // Touch for LRU recency. We deliberately keep returning stale entries (no
  // delete here) so the stale-while-revalidate path can still surface them.
  sharedAgentMentionBrowseCache.delete(input.cacheKey);
  sharedAgentMentionBrowseCache.set(input.cacheKey, entry);
  const ageMs = input.diagnosticNow() - entry.cachedAt;
  const isFresh =
    input.browseCacheTtlMs >= 0 &&
    Number.isFinite(input.browseCacheTtlMs) &&
    ageMs <= input.browseCacheTtlMs;
  return { entry, isFresh };
}

export function buildAgentMentionBrowseCacheKey(input: {
  workspaceId: string;
  currentUserId: string;
  filter: AgentMentionFilterId;
  sessionCwd: string;
  sectionKey: string;
  fileLimit: number;
  issueLimit: number;
  providerIds: readonly string[];
  provenanceFilterKey?: string;
}): string {
  return JSON.stringify({
    workspaceId: input.workspaceId,
    currentUserId: input.currentUserId,
    sessionCwd: input.sessionCwd,
    sectionKey: input.sectionKey,
    filter: input.filter,
    fileLimit: input.fileLimit,
    issueLimit: input.issueLimit,
    providerIds: input.providerIds,
    provenanceFilterKey: input.provenanceFilterKey ?? "disabled"
  });
}
