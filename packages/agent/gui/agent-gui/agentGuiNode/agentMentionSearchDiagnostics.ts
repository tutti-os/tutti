import type {
  AgentMentionFilterId,
  AgentMentionGroup
} from "./AgentMentionSearchController";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "./agentContextMentionProvider";

export type AgentMentionProviderDiagnosticStatus =
  | "success"
  | "timeout"
  | "error"
  | "missing";

export interface AgentMentionProviderQueryDiagnostic {
  durationMs: number;
  errorKind?: string;
  providerId: string;
  resultCount: number;
  status: AgentMentionProviderDiagnosticStatus;
}

export interface AgentMentionSearchDiagnosticLog {
  debounceMs: number;
  durationMs: number;
  errorKind?: string;
  event: "agent_gui.mention_search";
  filter: AgentMentionFilterId;
  groupCount: number;
  itemCount: number;
  mode: "browse" | "results";
  providerResults: AgentMentionProviderQueryDiagnostic[];
  providerTimeoutMs: number;
  queryLength: number;
  requestId: number;
  status: "ready" | "error";
  workspaceId: string;
}

const AGENT_MENTION_SEARCH_LOG_PREFIX = "[agent-gui] mention-search";
const {
  agentGeneratedFile: AGENT_GENERATED_FILE_PROVIDER_ID,
  agentSession: AGENT_SESSION_PROVIDER_ID,
  file: FILE_PROVIDER_ID,
  workspaceApp: WORKSPACE_APP_PROVIDER_ID,
  workspaceIssue: WORKSPACE_ISSUE_PROVIDER_ID
} = AGENT_CONTEXT_MENTION_PROVIDER_IDS;
const AGENT_MENTION_PROVIDER_LOG_ORDER: readonly string[] = [
  FILE_PROVIDER_ID,
  AGENT_GENERATED_FILE_PROVIDER_ID,
  WORKSPACE_APP_PROVIDER_ID,
  WORKSPACE_ISSUE_PROVIDER_ID,
  AGENT_SESSION_PROVIDER_ID
];

export function emitAgentMentionSearchDiagnostic(input: {
  debounceMs: number;
  diagnosticInfoLogger: (payload: AgentMentionSearchDiagnosticLog) => void;
  diagnosticNow: () => number;
  diagnosticSlowThresholdMs: number;
  error?: unknown;
  filter: AgentMentionFilterId;
  groups: readonly AgentMentionGroup[];
  mode: "browse" | "results";
  providerDiagnostics: readonly AgentMentionProviderQueryDiagnostic[];
  providerTimeoutMs: number;
  query: string;
  requestId: number;
  startedAt: number;
  status: "ready" | "error";
  workspaceId: string;
}): void {
  const durationMs = elapsedAgentMentionSearchDiagnosticMs(
    input.diagnosticNow(),
    input.startedAt
  );
  const providerResults = orderAgentMentionProviderDiagnostics(
    input.providerDiagnostics
  );
  const hasProviderIssue = providerResults.some(
    (result) => result.status === "timeout" || result.status === "error"
  );
  if (
    input.status === "ready" &&
    !hasProviderIssue &&
    durationMs < input.diagnosticSlowThresholdMs
  ) {
    return;
  }
  const payload: AgentMentionSearchDiagnosticLog = {
    debounceMs: input.debounceMs,
    durationMs,
    ...(input.status === "error"
      ? { errorKind: agentMentionSearchErrorKind(input.error) }
      : {}),
    event: "agent_gui.mention_search",
    filter: input.filter,
    groupCount: input.groups.length,
    itemCount: input.groups.reduce((sum, group) => sum + group.items.length, 0),
    mode: input.mode,
    providerResults,
    providerTimeoutMs: input.providerTimeoutMs,
    queryLength: [...input.query].length,
    requestId: input.requestId,
    status: input.status,
    workspaceId: input.workspaceId
  };
  try {
    input.diagnosticInfoLogger(payload);
  } catch {
    // Diagnostic logging must never affect mention search state.
  }
}

export async function queryAgentMentionProviderWithDiagnostics<T>(input: {
  abortSignal?: AbortSignal;
  diagnosticNow: () => number;
  diagnostics: AgentMentionProviderQueryDiagnostic[];
  fallback: T;
  providerId: string;
  providerTimeoutMs: number;
  query: ((abortSignal: AbortSignal) => Promise<T>) | null;
  resultCount: (result: T) => number;
  throwOnTimeout?: boolean;
}): Promise<T> {
  if (!input.query) {
    input.diagnostics.push({
      durationMs: 0,
      providerId: input.providerId,
      resultCount: 0,
      status: "missing"
    });
    return input.fallback;
  }
  const startedAt = input.diagnosticNow();
  try {
    const { result, timedOut } = await runAgentMentionProviderQuery({
      abortSignal: input.abortSignal,
      fallback: input.fallback,
      providerTimeoutMs: input.providerTimeoutMs,
      query: input.query
    });
    input.diagnostics.push({
      durationMs: elapsedAgentMentionSearchDiagnosticMs(
        input.diagnosticNow(),
        startedAt
      ),
      providerId: input.providerId,
      resultCount: input.resultCount(result),
      status: timedOut ? "timeout" : "success"
    });
    if (timedOut && input.throwOnTimeout) {
      const error = new Error("Mention provider query timed out.");
      error.name = "TimeoutError";
      throw error;
    }
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TimeoutError" &&
      input.diagnostics.at(-1)?.providerId === input.providerId &&
      input.diagnostics.at(-1)?.status === "timeout"
    ) {
      throw error;
    }
    input.diagnostics.push({
      durationMs: elapsedAgentMentionSearchDiagnosticMs(
        input.diagnosticNow(),
        startedAt
      ),
      errorKind: agentMentionSearchErrorKind(error),
      providerId: input.providerId,
      resultCount: 0,
      status: "error"
    });
    throw error;
  }
}

function elapsedAgentMentionSearchDiagnosticMs(
  now: number,
  startedAt: number
): number {
  const durationMs = now - startedAt;
  if (!Number.isFinite(durationMs)) {
    return 0;
  }
  return Math.max(0, Math.round(durationMs));
}

function agentMentionSearchErrorKind(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return error.name.trim();
  }
  if (error === null) {
    return "null";
  }
  return typeof error;
}

export function logAgentMentionSearchInfo(
  payload: AgentMentionSearchDiagnosticLog
): void {
  console.info(AGENT_MENTION_SEARCH_LOG_PREFIX, JSON.stringify(payload));
}

function orderAgentMentionProviderDiagnostics(
  diagnostics: readonly AgentMentionProviderQueryDiagnostic[]
): AgentMentionProviderQueryDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const leftIndex = providerDiagnosticOrder(left.providerId);
    const rightIndex = providerDiagnosticOrder(right.providerId);
    return (
      leftIndex - rightIndex || left.providerId.localeCompare(right.providerId)
    );
  });
}

function providerDiagnosticOrder(providerId: string): number {
  const index = AGENT_MENTION_PROVIDER_LOG_ORDER.indexOf(providerId);
  return index === -1 ? AGENT_MENTION_PROVIDER_LOG_ORDER.length : index;
}

async function runAgentMentionProviderQuery<T>(input: {
  abortSignal?: AbortSignal;
  fallback: T;
  providerTimeoutMs: number;
  query: (abortSignal: AbortSignal) => Promise<T>;
}): Promise<{ result: T; timedOut: boolean }> {
  const abortController = new AbortController();
  const abortFromParent = () => abortController.abort();
  if (input.abortSignal?.aborted) {
    abortController.abort();
  } else {
    input.abortSignal?.addEventListener("abort", abortFromParent, {
      once: true
    });
  }
  let timedOut = false;
  const queryPromise = Promise.resolve().then(() =>
    input.query(abortController.signal)
  );
  const queryResultPromise = queryPromise.then(
    (result) => ({ result, timedOut: false }),
    (error) => {
      if (timedOut && abortController.signal.aborted) {
        return { result: input.fallback, timedOut: true };
      }
      throw error;
    }
  );

  if (
    input.providerTimeoutMs <= 0 ||
    !Number.isFinite(input.providerTimeoutMs)
  ) {
    try {
      return await queryResultPromise;
    } finally {
      input.abortSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<{ result: T; timedOut: boolean }>(
    (resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        resolve({ result: input.fallback, timedOut: true });
      }, input.providerTimeoutMs);
    }
  );

  try {
    return await Promise.race([queryResultPromise, timeoutPromise]);
  } finally {
    input.abortSignal?.removeEventListener("abort", abortFromParent);
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}
