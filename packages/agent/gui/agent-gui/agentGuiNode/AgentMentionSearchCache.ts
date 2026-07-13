import type { AgentMentionProviderQueryDiagnostic } from "./agentMentionSearchDiagnostics";
import type {
  AgentMentionFilterId,
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
}

export interface AgentMentionBrowseCacheEntry extends AgentMentionBrowseFetchResult {
  cachedAt: number;
}

export type AgentMentionBrowseLoadReason = "open" | "preload";

const sharedAgentMentionBrowseCache = new Map<
  string,
  AgentMentionBrowseCacheEntry
>();
const sharedAgentMentionBrowseFetches = new Map<
  string,
  Promise<AgentMentionBrowseFetchResult>
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
  };
  cacheKey: string;
  reason: AgentMentionBrowseLoadReason;
  diagnosticNow: () => number;
  providerIds: string;
  fetchBrowseResult: () => Promise<AgentMentionBrowseFetchResult>;
  logLifecycle: (
    event: AgentMentionLifecycleDiagnosticLog["event"],
    details: AgentMentionLifecycleDiagnosticLog["details"]
  ) => void;
}): Promise<AgentMentionBrowseFetchResult> {
  const { cacheKey, reason } = input;
  const browseInput = input.input;
  const existingFetch = sharedAgentMentionBrowseFetches.get(cacheKey);
  if (existingFetch) {
    input.logLifecycle("browse.fetch.dedupe", {
      filter: browseInput.filter,
      reason,
      workspaceId: browseInput.workspaceId
    });
    return existingFetch;
  }
  const startedAt = input.diagnosticNow();
  input.logLifecycle("browse.fetch.start", {
    filter: browseInput.filter,
    providerIds: input.providerIds,
    reason,
    workspaceId: browseInput.workspaceId
  });
  const fetchPromise = input
    .fetchBrowseResult()
    .then((result) => {
      writeBrowseCacheEntry(cacheKey, {
        ...result,
        cachedAt: input.diagnosticNow()
      });
      input.logLifecycle("browse.fetch.success", {
        durationMs: elapsedDiagnosticMs(input.diagnosticNow(), startedAt),
        filter: browseInput.filter,
        itemCount: rawGroupItemCount(result.rawGroups),
        providerResults: providerDiagnosticsSummary(result.providerDiagnostics),
        reason,
        workspaceId: browseInput.workspaceId
      });
      return result;
    })
    .finally(() => {
      if (sharedAgentMentionBrowseFetches.get(cacheKey) === fetchPromise) {
        sharedAgentMentionBrowseFetches.delete(cacheKey);
      }
    });
  sharedAgentMentionBrowseFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
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
  fileLimit: number;
  issueLimit: number;
  providerIds: readonly string[];
}): string {
  return JSON.stringify({
    workspaceId: input.workspaceId,
    currentUserId: input.currentUserId,
    sessionCwd: input.sessionCwd,
    filter: input.filter,
    fileLimit: input.fileLimit,
    issueLimit: input.issueLimit,
    providerIds: input.providerIds
  });
}
