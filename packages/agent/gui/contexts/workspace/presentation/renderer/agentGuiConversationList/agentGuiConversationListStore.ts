import { mergeAgentActivityMessages } from "@tutti-os/agent-activity-core";
import {
  getAgentActivityRuntime,
  getOptionalAgentActivityRuntime
} from "../../../../../agentActivityRuntime";
import { getOptionalAgentHostApi } from "../../../../../agentActivityHost";
import type { AgentGUIProvider } from "../types";
import { getAgentSessionViewStoreSnapshot } from "../agentSessions/agentSessionViewStore";
import {
  buildAgentGUIConversationSummaries,
  resolveAgentGUIConversationSortTimeUnixMs,
  resolveAgentGUIConversationTitleFromMessages,
  type AgentGUIConversationSummary
} from "../../../../../agent-gui/agentGuiNode/model/agentGuiConversationModel";
import { resolveAgentGUIExplicitConversationTitle } from "../../../../../agent-gui/agentGuiNode/model/agentGuiProviderIdentity";
import {
  mergeWorkspaceAgentActivityDurableAndOverlayMessages,
  selectWorkspaceAgentActivityOverlayMessages,
  type WorkspaceAgentActivityMessage,
  type WorkspaceAgentActivitySnapshot,
  type WorkspaceAgentActivitySyncState
} from "../../../../../shared/workspaceAgentActivityTypes";
import type {
  RuntimeDiagnosticsDetailValue,
  WorkspaceAgentReadStateBucket,
  WorkspaceAgentReadStateSnapshot
} from "../../../../../shared/contracts/dto";
import {
  clearAgentGUIConversationCreatePendingState,
  clearAgentGUIConversationSubmitPendingState,
  getAgentGUIConversationCreatePendingState,
  getAgentGUIConversationSubmitPendingState,
  markAgentGUIConversationCreatePendingState,
  markAgentGUIConversationSubmitPendingState,
  resetAgentGUIConversationPendingStateForTests
} from "./agentGuiConversationListPendingState";
import { workspaceAgentSnapshotForConversations } from "./agentGuiConversationListSnapshot";

const REFRESH_DEBOUNCE_MS = 200;
const UPDATE_STORM_DIAGNOSTIC_WINDOW_MS = 1000;
const UPDATE_STORM_DIAGNOSTIC_THRESHOLD = 8;
const MAX_DIAGNOSTIC_STACK_LENGTH = 2000;

export interface AgentGUIConversationListQuery {
  workspaceId: string;
  userId: string;
  provider: AgentGUIProvider;
  sessionOrigin: string;
}

type NormalizedAgentGUIConversationListQuery = Required<
  Omit<AgentGUIConversationListQuery, "workspaceId">
> & {
  workspaceId: string;
};

export interface AgentGUIConversationListQueryState {
  queryKey: string;
  query: NormalizedAgentGUIConversationListQuery;
  conversations: AgentGUIConversationSummary[];
  isLoading: boolean;
  initialized: boolean;
  error: string | null;
}

interface AgentGUIConversationListStoreSnapshot {
  statesByQueryKey: Record<string, AgentGUIConversationListQueryState>;
}

type StoreListener = () => void;
type RefreshReason =
  | "projection-sync"
  | "local-create"
  | "local-delete"
  | "session-overlay-update"
  | "workspace-agent-update";
type ConversationListUpdateReason =
  | RefreshReason
  | "active-conversation"
  | "completion-observed"
  | "external-update"
  | "local-created"
  | "pin-changed"
  | "submit-pending";

interface ConversationListRefreshOptions {
  dirtySessionIds?: readonly string[];
}

const EMPTY_SNAPSHOT: AgentGUIConversationListStoreSnapshot = {
  statesByQueryKey: {}
};

let snapshot: AgentGUIConversationListStoreSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<StoreListener>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflightRefreshByQueryKey = new Map<string, Promise<void>>();
const needsRefreshAfterInflight = new Set<string>();
const pendingDirtySessionIdsByQueryKey = new Map<string, Set<string>>();
const requestIdByQueryKey = new Map<string, number>();
const localCreatedConversationIdsByQueryKey = new Map<string, Set<string>>();
const deletedConversationIdsByQueryKey = new Map<string, Set<string>>();
const readStateByQueryKey = new Map<string, WorkspaceAgentReadStateSnapshot>();
const readStateLoadByQueryKey = new Map<
  string,
  Promise<WorkspaceAgentReadStateSnapshot>
>();
const runtimeRefreshUnsubscribeByWorkspaceId = new Map<string, () => void>();
const activeConversationIdsByQueryKey = new Map<string, Map<string, string>>();
const updateStormDiagnosticsByQueryKey = new Map<
  string,
  {
    firstReason: ConversationListUpdateReason;
    firstStack: string | null;
    logged: boolean;
    updateCount: number;
    windowStartedAtMs: number;
  }
>();

function normalizeQuery(
  input: AgentGUIConversationListQuery
): NormalizedAgentGUIConversationListQuery | null {
  const workspaceId = input.workspaceId.trim();
  const userId = input.userId.trim();
  const provider = input.provider.trim() as AgentGUIProvider;
  const sessionOrigin = input.sessionOrigin.trim();
  if (!workspaceId || !userId || !provider || !sessionOrigin) {
    return null;
  }
  return {
    workspaceId,
    userId,
    provider,
    sessionOrigin
  };
}

export function createAgentGUIConversationListQueryKey(
  input: AgentGUIConversationListQuery
): string | null {
  const normalized = normalizeQuery(input);
  return normalized
    ? [
        normalized.workspaceId,
        normalized.userId,
        normalized.provider,
        normalized.sessionOrigin
      ].join("::")
    : null;
}

function createEmptyQueryState(
  query: AgentGUIConversationListQuery
): AgentGUIConversationListQueryState {
  const normalized = normalizeQuery(query)!;
  return {
    queryKey: createAgentGUIConversationListQueryKey(normalized)!,
    query: normalized,
    conversations: [],
    isLoading: false,
    initialized: false,
    error: null
  };
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function getOrCreateQueryState(
  query: AgentGUIConversationListQuery,
  options: { emitCreated: boolean }
): AgentGUIConversationListQueryState | null {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return null;
  }
  ensureWorkspaceAgentRuntimeRefresh(normalized.workspaceId);
  const queryKey = createAgentGUIConversationListQueryKey(normalized)!;
  const existing = snapshot.statesByQueryKey[queryKey];
  if (existing) {
    return existing;
  }
  const created = createEmptyQueryState(normalized);
  snapshot = {
    statesByQueryKey: {
      ...snapshot.statesByQueryKey,
      [queryKey]: created
    }
  };
  if (options.emitCreated) {
    emitChange();
  }
  return created;
}

function ensureQueryState(
  query: AgentGUIConversationListQuery
): AgentGUIConversationListQueryState | null {
  return getOrCreateQueryState(query, { emitCreated: true });
}

function updateQueryState(
  query: AgentGUIConversationListQuery,
  updater: (
    current: AgentGUIConversationListQueryState
  ) => AgentGUIConversationListQueryState
): void {
  const current = ensureQueryState(query);
  if (!current) {
    return;
  }
  const next = updater(current);
  if (next === current) {
    return;
  }
  snapshot = {
    statesByQueryKey: {
      ...snapshot.statesByQueryKey,
      [current.queryKey]: next
    }
  };
  emitChange();
}

function getQueryState(
  query: AgentGUIConversationListQuery
): AgentGUIConversationListQueryState | null {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return null;
  }
  const queryKey = createAgentGUIConversationListQueryKey(normalized)!;
  return snapshot.statesByQueryKey[queryKey] ?? null;
}

function hasActiveConversationOwner(
  queryKey: string,
  conversationId: string
): boolean {
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) {
    return false;
  }
  const activeByOwner = activeConversationIdsByQueryKey.get(queryKey);
  if (!activeByOwner) {
    return false;
  }
  for (const activeConversationId of activeByOwner.values()) {
    if (activeConversationId === normalizedConversationId) {
      return true;
    }
  }
  return false;
}

function emptyWorkspaceAgentReadState(): WorkspaceAgentReadStateSnapshot {
  return {
    completed: { readIds: [], unreadIds: [] },
    failed: { readIds: [], unreadIds: [] }
  };
}

function normalizeWorkspaceAgentReadState(
  value: unknown
): WorkspaceAgentReadStateSnapshot {
  const record = value && typeof value === "object" ? value : {};
  return {
    completed: normalizeWorkspaceAgentReadStateBucket(
      (record as { completed?: unknown }).completed
    ),
    failed: normalizeWorkspaceAgentReadStateBucket(
      (record as { failed?: unknown }).failed
    )
  };
}

function normalizeWorkspaceAgentReadStateBucket(
  value: unknown
): WorkspaceAgentReadStateBucket {
  const record = value && typeof value === "object" ? value : {};
  return {
    readIds: normalizeIdList((record as { readIds?: unknown }).readIds),
    unreadIds: normalizeIdList((record as { unreadIds?: unknown }).unreadIds)
  };
}

function normalizeIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => `${item}`.trim()).filter(Boolean))]
    : [];
}

function normalizeCompletionKey(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function isCompletedRead(
  readState: WorkspaceAgentReadStateSnapshot,
  completionKey: string
): boolean {
  return readState.completed.readIds.includes(completionKey);
}

function updateCompletedReadState(
  queryState: AgentGUIConversationListQueryState,
  completionKey: string
): void {
  const normalizedCompletionKey = normalizeCompletionKey(completionKey);
  if (!normalizedCompletionKey) {
    return;
  }
  const current =
    readStateByQueryKey.get(queryState.queryKey) ??
    emptyWorkspaceAgentReadState();
  if (current.completed.readIds.includes(normalizedCompletionKey)) {
    return;
  }
  const next: WorkspaceAgentReadStateSnapshot = {
    ...current,
    completed: {
      readIds: [...current.completed.readIds, normalizedCompletionKey],
      unreadIds: current.completed.unreadIds.filter(
        (id) => id !== normalizedCompletionKey
      )
    }
  };
  readStateByQueryKey.set(queryState.queryKey, next);
  void persistCompletedReadState(queryState, next.completed);
}

async function persistCompletedReadState(
  queryState: AgentGUIConversationListQueryState,
  completed: WorkspaceAgentReadStateBucket
): Promise<void> {
  try {
    await getOptionalAgentHostApi()?.persistence?.writeWorkspaceAgentReadState({
      roomId: queryState.query.workspaceId,
      userId: queryState.query.userId,
      kind: "completed",
      readIds: completed.readIds,
      unreadIds: completed.unreadIds
    });
  } catch {
    // Persistence is a best-effort UI hint; keep in-memory state authoritative.
  }
}

async function loadWorkspaceAgentReadState(
  queryState: AgentGUIConversationListQueryState
): Promise<WorkspaceAgentReadStateSnapshot> {
  const cached = readStateByQueryKey.get(queryState.queryKey);
  if (cached) {
    return cached;
  }
  const inflight = readStateLoadByQueryKey.get(queryState.queryKey);
  if (inflight) {
    return inflight;
  }
  const promise = (async () => {
    try {
      const loaded =
        await getOptionalAgentHostApi()?.persistence?.readWorkspaceAgentReadState(
          {
            roomId: queryState.query.workspaceId,
            userId: queryState.query.userId
          }
        );
      const normalized = normalizeWorkspaceAgentReadState(loaded);
      const current = readStateByQueryKey.get(queryState.queryKey);
      if (current) {
        return current;
      }
      readStateByQueryKey.set(queryState.queryKey, normalized);
      return normalized;
    } catch {
      const empty = emptyWorkspaceAgentReadState();
      readStateByQueryKey.set(queryState.queryKey, empty);
      return empty;
    } finally {
      readStateLoadByQueryKey.delete(queryState.queryKey);
    }
  })();
  readStateLoadByQueryKey.set(queryState.queryKey, promise);
  return promise;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hasPromptConversationTitle(
  conversation: AgentGUIConversationSummary
): boolean {
  return resolveAgentGUIExplicitConversationTitle(conversation) !== null;
}

function mergeLoadedConversationTitleFields(
  current: AgentGUIConversationSummary | undefined,
  incoming: AgentGUIConversationSummary,
  preferCurrent: boolean
): Pick<AgentGUIConversationSummary, "title" | "titleFallback"> {
  if (!current) {
    return {
      title: incoming.title,
      titleFallback: incoming.titleFallback
    };
  }
  const currentHasPromptTitle = hasPromptConversationTitle(current);
  const incomingHasPromptTitle = hasPromptConversationTitle(incoming);
  if (currentHasPromptTitle && !incomingHasPromptTitle) {
    return {
      title: current.title,
      titleFallback: current.titleFallback
    };
  }
  if (incomingHasPromptTitle && !currentHasPromptTitle) {
    return {
      title: incoming.title,
      titleFallback: incoming.titleFallback
    };
  }
  if (preferCurrent && current.title.trim()) {
    return {
      title: current.title,
      titleFallback: current.titleFallback
    };
  }
  return {
    title: incoming.title,
    titleFallback: incoming.titleFallback
  };
}

function isTerminalConversationStatus(
  status: AgentGUIConversationSummary["status"]
): boolean {
  return status === "completed" || status === "failed";
}

function conversationBusyStatus(
  status: AgentGUIConversationSummary["status"] | null
): boolean {
  return status === "working" || status === "waiting";
}

function syncStateUpdatedAtUnixMs(
  syncState: WorkspaceAgentActivitySyncState | null | undefined
): number | null {
  const updatedAtUnixMs = syncState?.updatedAtUnixMs;
  return typeof updatedAtUnixMs === "number" && Number.isFinite(updatedAtUnixMs)
    ? updatedAtUnixMs
    : null;
}

function shouldPreserveLocalConversation(
  current: AgentGUIConversationSummary,
  incoming: AgentGUIConversationSummary
): boolean {
  if (current.updatedAtUnixMs > incoming.updatedAtUnixMs) {
    return true;
  }
  if (
    !conversationBusyStatus(current.status) &&
    conversationBusyStatus(incoming.status)
  ) {
    return current.updatedAtUnixMs === incoming.updatedAtUnixMs;
  }
  if (conversationBusyStatus(current.status) && incoming.status === "ready") {
    return current.updatedAtUnixMs === incoming.updatedAtUnixMs;
  }
  if (
    conversationBusyStatus(current.status) &&
    !conversationBusyStatus(incoming.status)
  ) {
    return false;
  }
  return (
    current.updatedAtUnixMs === incoming.updatedAtUnixMs &&
    isTerminalConversationStatus(current.status) &&
    !isTerminalConversationStatus(incoming.status)
  );
}

function mergeLoadedConversation(
  current: AgentGUIConversationSummary | undefined,
  incoming: AgentGUIConversationSummary
): AgentGUIConversationSummary {
  const preserveLocalConversation = current
    ? shouldPreserveLocalConversation(current, incoming)
    : false;
  const currentUpdatedAtUnixMs = current?.updatedAtUnixMs ?? 0;
  const incomingUpdatedAtUnixMs = incoming.updatedAtUnixMs ?? 0;
  const preferCurrent =
    preserveLocalConversation ||
    currentUpdatedAtUnixMs > incomingUpdatedAtUnixMs;
  const currentSyncStateUpdatedAtUnixMs = syncStateUpdatedAtUnixMs(
    current?.syncState
  );
  const incomingSyncStateUpdatedAtUnixMs = syncStateUpdatedAtUnixMs(
    incoming.syncState
  );
  const pinnedAtUnixMs = Object.prototype.hasOwnProperty.call(
    incoming,
    "pinnedAtUnixMs"
  )
    ? (incoming.pinnedAtUnixMs ?? null)
    : (current?.pinnedAtUnixMs ?? null);
  // `project` is intentionally not merged/preserved here: it is a view-only
  // JOIN of cwd × userProjects derived in the view layer, never canonical store
  // state. Whatever `incoming` carries (normally undefined) flows through.
  const merged: AgentGUIConversationSummary = {
    ...incoming,
    ...mergeLoadedConversationTitleFields(current, incoming, preferCurrent),
    ...(incoming.isImported === true || current?.isImported === true
      ? { isImported: true }
      : {}),
    hasUnreadCompletion:
      incoming.hasUnreadCompletion ||
      (preferCurrent ? current?.hasUnreadCompletion : false),
    unreadCompletionKey:
      incoming.unreadCompletionKey ??
      (preferCurrent ? current?.unreadCompletionKey : null),
    pinnedAtUnixMs,
    sortTimeUnixMs: maxOptionalTimeUnixMs(
      current?.sortTimeUnixMs,
      incoming.sortTimeUnixMs
    ),
    status:
      preserveLocalConversation && current ? current.status : incoming.status,
    updatedAtUnixMs: Math.max(currentUpdatedAtUnixMs, incomingUpdatedAtUnixMs),
    syncState:
      currentSyncStateUpdatedAtUnixMs !== null &&
      (incomingSyncStateUpdatedAtUnixMs === null ||
        currentSyncStateUpdatedAtUnixMs > incomingSyncStateUpdatedAtUnixMs)
        ? current?.syncState
        : incoming.syncState
  };
  return current && areConversationsEqual(current, merged) ? current : merged;
}

function areConversationTitleFallbacksEqual(
  left: AgentGUIConversationSummary["titleFallback"],
  right: AgentGUIConversationSummary["titleFallback"]
): boolean {
  if (left === right) {
    return true;
  }
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function areConversationSyncStatesEqual(
  left: AgentGUIConversationSummary["syncState"],
  right: AgentGUIConversationSummary["syncState"]
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.workspaceId === right.workspaceId &&
    left.agentSessionId === right.agentSessionId &&
    left.status === right.status &&
    left.pendingTimelineItemCount === right.pendingTimelineItemCount &&
    left.pendingStatePatchCount === right.pendingStatePatchCount &&
    left.attemptCount === right.attemptCount &&
    left.failedReportCount === right.failedReportCount &&
    left.lastError === right.lastError &&
    left.lastAttemptAtUnixMs === right.lastAttemptAtUnixMs &&
    left.lastSyncedAtUnixMs === right.lastSyncedAtUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs
  );
}

function areConversationProjectsEqual(
  left: AgentGUIConversationSummary["project"],
  right: AgentGUIConversationSummary["project"]
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.id === right.id &&
    left.path === right.path &&
    left.label === right.label &&
    left.createdAtUnixMs === right.createdAtUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    left.lastUsedAtUnixMs === right.lastUsedAtUnixMs
  );
}

function areConversationsEqual(
  left: AgentGUIConversationSummary,
  right: AgentGUIConversationSummary
): boolean {
  return (
    left.id === right.id &&
    left.userId === right.userId &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.status === right.status &&
    left.cwd === right.cwd &&
    areConversationProjectsEqual(left.project, right.project) &&
    left.sortTimeUnixMs === right.sortTimeUnixMs &&
    left.updatedAtUnixMs === right.updatedAtUnixMs &&
    (left.pinnedAtUnixMs ?? 0) === (right.pinnedAtUnixMs ?? 0) &&
    left.isImported === right.isImported &&
    left.hasUnreadCompletion === right.hasUnreadCompletion &&
    left.unreadCompletionKey === right.unreadCompletionKey &&
    areConversationTitleFallbacksEqual(
      left.titleFallback,
      right.titleFallback
    ) &&
    areConversationSyncStatesEqual(left.syncState, right.syncState)
  );
}

function areConversationListsEqual(
  left: readonly AgentGUIConversationSummary[],
  right: readonly AgentGUIConversationSummary[]
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((conversation, index) =>
    areConversationsEqual(conversation, right[index]!)
  );
}

function addChangedConversationField(
  fields: Set<string>,
  changedIds: string[],
  conversationId: string,
  field: string
): void {
  fields.add(field);
  if (!changedIds.includes(conversationId) && changedIds.length < 5) {
    changedIds.push(conversationId);
  }
}

function describeConversationListChange(
  previous: readonly AgentGUIConversationSummary[],
  next: readonly AgentGUIConversationSummary[]
): {
  changedFields: string;
  changedIds: string;
  orderChanged: boolean;
} {
  const fields = new Set<string>();
  const changedIds: string[] = [];
  let orderChanged = false;
  if (previous.length !== next.length) {
    fields.add("length");
  }
  const maxLength = Math.max(previous.length, next.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (!left || !right) {
      addChangedConversationField(
        fields,
        changedIds,
        left?.id ?? right?.id ?? "unknown",
        left ? "removed" : "added"
      );
      continue;
    }
    if (left.id !== right.id) {
      orderChanged = true;
      addChangedConversationField(fields, changedIds, right.id, "order");
      continue;
    }
    if (left.title !== right.title) {
      addChangedConversationField(fields, changedIds, right.id, "title");
    }
    if (left.status !== right.status) {
      addChangedConversationField(fields, changedIds, right.id, "status");
    }
    if (left.cwd !== right.cwd) {
      addChangedConversationField(fields, changedIds, right.id, "cwd");
    }
    if (!areConversationProjectsEqual(left.project, right.project)) {
      addChangedConversationField(fields, changedIds, right.id, "project");
    }
    if (left.sortTimeUnixMs !== right.sortTimeUnixMs) {
      addChangedConversationField(
        fields,
        changedIds,
        right.id,
        "sortTimeUnixMs"
      );
    }
    if (left.updatedAtUnixMs !== right.updatedAtUnixMs) {
      addChangedConversationField(
        fields,
        changedIds,
        right.id,
        "updatedAtUnixMs"
      );
    }
    if ((left.pinnedAtUnixMs ?? 0) !== (right.pinnedAtUnixMs ?? 0)) {
      addChangedConversationField(
        fields,
        changedIds,
        right.id,
        "pinnedAtUnixMs"
      );
    }
    if (left.isImported !== right.isImported) {
      addChangedConversationField(fields, changedIds, right.id, "isImported");
    }
    if (left.hasUnreadCompletion !== right.hasUnreadCompletion) {
      addChangedConversationField(
        fields,
        changedIds,
        right.id,
        "hasUnreadCompletion"
      );
    }
    if (left.unreadCompletionKey !== right.unreadCompletionKey) {
      addChangedConversationField(
        fields,
        changedIds,
        right.id,
        "unreadCompletionKey"
      );
    }
    if (
      !areConversationTitleFallbacksEqual(
        left.titleFallback,
        right.titleFallback
      )
    ) {
      addChangedConversationField(
        fields,
        changedIds,
        right.id,
        "titleFallback"
      );
    }
    if (!areConversationSyncStatesEqual(left.syncState, right.syncState)) {
      addChangedConversationField(fields, changedIds, right.id, "syncState");
    }
  }
  return {
    changedFields: Array.from(fields).sort().join(",") || "unknown",
    changedIds: changedIds.join(","),
    orderChanged
  };
}

function truncateDiagnosticStack(stack: string | undefined): string | null {
  if (!stack) {
    return null;
  }
  return stack.length > MAX_DIAGNOSTIC_STACK_LENGTH
    ? stack.slice(0, MAX_DIAGNOSTIC_STACK_LENGTH)
    : stack;
}

function recordConversationListUpdateDiagnostics(input: {
  current: AgentGUIConversationListQueryState;
  nextConversations: readonly AgentGUIConversationSummary[];
  reason: ConversationListUpdateReason;
}): void {
  const now = Date.now();
  const currentWindow = updateStormDiagnosticsByQueryKey.get(
    input.current.queryKey
  );
  const windowState =
    currentWindow &&
    now - currentWindow.windowStartedAtMs <= UPDATE_STORM_DIAGNOSTIC_WINDOW_MS
      ? currentWindow
      : {
          firstReason: input.reason,
          firstStack: truncateDiagnosticStack(new Error().stack),
          logged: false,
          updateCount: 0,
          windowStartedAtMs: now
        };
  windowState.updateCount += 1;
  updateStormDiagnosticsByQueryKey.set(input.current.queryKey, windowState);
  if (
    windowState.logged ||
    windowState.updateCount < UPDATE_STORM_DIAGNOSTIC_THRESHOLD
  ) {
    return;
  }
  windowState.logged = true;
  const change = describeConversationListChange(
    input.current.conversations,
    input.nextConversations
  );
  const details: Record<string, RuntimeDiagnosticsDetailValue> = {
    changedFields: change.changedFields,
    changedIds: change.changedIds,
    firstReason: windowState.firstReason,
    firstStack: windowState.firstStack,
    nextCount: input.nextConversations.length,
    orderChanged: change.orderChanged,
    previousCount: input.current.conversations.length,
    provider: input.current.query.provider,
    queryKey: input.current.queryKey,
    reason: input.reason,
    sessionOrigin: input.current.query.sessionOrigin,
    updateCount: windowState.updateCount,
    windowMs: UPDATE_STORM_DIAGNOSTIC_WINDOW_MS,
    workspaceId: input.current.query.workspaceId
  };
  getOptionalAgentHostApi()?.debug?.logRuntimeDiagnostics?.({
    source: "renderer-workspace-surface",
    level: "info",
    event: "agent-gui.conversation-list.update-storm",
    // i18n-check-ignore: Internal diagnostic log message.
    message:
      "Agent GUI conversation list changed repeatedly in a short window.",
    details
  });
}

function mergeLoadedConversations(
  current: readonly AgentGUIConversationSummary[],
  incoming: readonly AgentGUIConversationSummary[],
  retainedSessionIds: ReadonlySet<string> = new Set()
): AgentGUIConversationSummary[] {
  const currentById = new Map(
    current.map((conversation) => [conversation.id, conversation])
  );
  const incomingIds = new Set(incoming.map((conversation) => conversation.id));
  const merged = incoming.map((conversation) =>
    mergeLoadedConversation(currentById.get(conversation.id), conversation)
  );
  for (const conversation of current) {
    if (incomingIds.has(conversation.id)) {
      continue;
    }
    if (!retainedSessionIds.has(conversation.id)) {
      continue;
    }
    merged.push(conversation);
  }
  return merged;
}

function createConversationOrderIndex(
  conversations: readonly AgentGUIConversationSummary[]
): ReadonlyMap<string, number> {
  return new Map(
    conversations.map((conversation, index) => [conversation.id, index])
  );
}

function sortConversationsByRecency(
  conversations: readonly AgentGUIConversationSummary[],
  previousOrderIndex: ReadonlyMap<string, number> = new Map()
): AgentGUIConversationSummary[] {
  return [...conversations].sort((left, right) => {
    const leftPinnedAtUnixMs = left.pinnedAtUnixMs ?? 0;
    const rightPinnedAtUnixMs = right.pinnedAtUnixMs ?? 0;
    if (leftPinnedAtUnixMs > 0 || rightPinnedAtUnixMs > 0) {
      if (leftPinnedAtUnixMs !== rightPinnedAtUnixMs) {
        return rightPinnedAtUnixMs - leftPinnedAtUnixMs;
      }
    }

    const recencyDelta =
      resolveAgentGUIConversationSortTimeUnixMs(right) -
      resolveAgentGUIConversationSortTimeUnixMs(left);
    if (recencyDelta !== 0) {
      return recencyDelta;
    }

    const leftPreviousIndex = previousOrderIndex.get(left.id);
    const rightPreviousIndex = previousOrderIndex.get(right.id);
    if (leftPreviousIndex !== undefined && rightPreviousIndex !== undefined) {
      return leftPreviousIndex - rightPreviousIndex;
    }
    if (leftPreviousIndex !== undefined) {
      return -1;
    }
    if (rightPreviousIndex !== undefined) {
      return 1;
    }

    return (
      left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
    );
  });
}

function maxOptionalTimeUnixMs(
  left: number | null | undefined,
  right: number | null | undefined
): number | undefined {
  const leftTime =
    typeof left === "number" && Number.isFinite(left) ? left : undefined;
  const rightTime =
    typeof right === "number" && Number.isFinite(right) ? right : undefined;
  if (leftTime === undefined) {
    return rightTime;
  }
  if (rightTime === undefined) {
    return leftTime;
  }
  return Math.max(leftTime, rightTime);
}

function upsertConversationOverlay(
  current: readonly AgentGUIConversationSummary[],
  incoming: AgentGUIConversationSummary
): AgentGUIConversationSummary[] {
  const existing = current.find(
    (conversation) => conversation.id === incoming.id
  );
  const merged = mergeLoadedConversation(existing, incoming);
  return sortConversationsByRecency(
    [
      merged,
      ...current.filter((conversation) => conversation.id !== incoming.id)
    ],
    createConversationOrderIndex(current)
  );
}

function workspaceSessionViewDataBySessionId(workspaceId: string): Record<
  string,
  {
    overlayMessages: WorkspaceAgentActivityMessage[];
  }
> {
  const allViews = getAgentSessionViewStoreSnapshot().sessionViewsBySessionKey;
  const prefix = `${workspaceId.trim()}:`;
  return Object.fromEntries(
    Object.values(allViews)
      .filter((view) => view.sessionKey.startsWith(prefix))
      .map((view) => [
        view.agentSessionId,
        {
          overlayMessages: view.overlayMessages
        }
      ])
  );
}

function nonEmptySessionMessagesById(
  durableMessagesBySessionId: Record<string, WorkspaceAgentActivityMessage[]>,
  sessionViewDataById: Record<
    string,
    {
      overlayMessages: WorkspaceAgentActivityMessage[];
    }
  >
): Record<string, WorkspaceAgentActivityMessage[]> {
  const result: Record<string, WorkspaceAgentActivityMessage[]> = {};
  for (const [agentSessionId, value] of Object.entries(sessionViewDataById)) {
    const overlayMessages = selectWorkspaceAgentActivityOverlayMessages({
      durableMessages: durableMessagesBySessionId[agentSessionId],
      localMessages: value.overlayMessages
    });
    if (overlayMessages.length > 0) {
      result[agentSessionId] = overlayMessages;
    }
  }
  return result;
}

function mergeSessionMessagesById(
  left: Record<string, WorkspaceAgentActivityMessage[]>,
  right: Record<string, WorkspaceAgentActivityMessage[]>
): Record<string, WorkspaceAgentActivityMessage[]> {
  const next: Record<string, WorkspaceAgentActivityMessage[]> = { ...left };
  for (const [agentSessionId, messages] of Object.entries(right)) {
    next[agentSessionId] = mergeAgentActivityMessages(
      next[agentSessionId] ?? [],
      messages
    );
  }
  return next;
}

function normalizeDirtySessionIds(
  sessionIds: readonly string[] | undefined
): string[] {
  if (!sessionIds || sessionIds.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const sessionId of sessionIds) {
    const value = sessionId.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function addPendingDirtySessionIds(
  queryKey: string,
  sessionIds: readonly string[] | undefined
): void {
  const normalized = normalizeDirtySessionIds(sessionIds);
  if (normalized.length === 0) {
    return;
  }
  const pending =
    pendingDirtySessionIdsByQueryKey.get(queryKey) ?? new Set<string>();
  for (const sessionId of normalized) {
    pending.add(sessionId);
  }
  pendingDirtySessionIdsByQueryKey.set(queryKey, pending);
}

function consumePendingDirtySessionIds(queryKey: string): Set<string> {
  const pending = pendingDirtySessionIdsByQueryKey.get(queryKey);
  pendingDirtySessionIdsByQueryKey.delete(queryKey);
  return pending ?? new Set<string>();
}

function latestCompletionKeyForConversation(input: {
  conversation: AgentGUIConversationSummary;
  messages: readonly WorkspaceAgentActivityMessage[];
}): string | null {
  const latestCompletedMessage = [...input.messages]
    .filter(isCompletedAgentMessage)
    .sort(compareMessagesByRecentTime)[0];
  if (latestCompletedMessage) {
    const subject =
      latestCompletedMessage.turnId?.trim() ||
      latestCompletedMessage.messageId.trim();
    return subject
      ? `turn:${input.conversation.id}:${subject}:completed`
      : null;
  }
  return input.conversation.status === "completed"
    ? `session:${input.conversation.id}:completed`
    : null;
}

function isCompletedAgentMessage(
  message: WorkspaceAgentActivityMessage
): boolean {
  if ((message.role ?? "").trim().toLowerCase() !== "assistant") {
    return false;
  }
  const kind = (message.kind ?? "").trim().toLowerCase();
  if (kind !== "message" && kind !== "text") {
    return false;
  }
  const payload =
    message.payload && typeof message.payload === "object"
      ? message.payload
      : {};
  const status =
    message.status?.trim().toLowerCase() ||
    stringPayloadValue(payload, "status").toLowerCase();
  return status === "completed";
}

function stringPayloadValue(
  payload: Record<string, unknown>,
  key: string
): string {
  const value = payload[key];
  return typeof value === "string" ? value.trim() : "";
}

function compareMessagesByRecentTime(
  left: WorkspaceAgentActivityMessage,
  right: WorkspaceAgentActivityMessage
): number {
  return (
    messageTime(right) - messageTime(left) ||
    right.messageId.localeCompare(left.messageId)
  );
}

function messageTime(message: WorkspaceAgentActivityMessage): number {
  return (
    message.completedAtUnixMs ??
    message.occurredAtUnixMs ??
    message.startedAtUnixMs ??
    message.version ??
    0
  );
}

function decorateConversationForRefresh(input: {
  conversation: AgentGUIConversationSummary;
  mergedMessages: readonly WorkspaceAgentActivityMessage[];
  queryKey: string;
  readState: WorkspaceAgentReadStateSnapshot;
}): AgentGUIConversationSummary {
  const title = resolveAgentGUIConversationTitleFromMessages({
    messages: input.mergedMessages,
    conversation: input.conversation
  });
  const completionKey = latestCompletionKeyForConversation({
    conversation: input.conversation,
    messages: input.mergedMessages
  });
  const hasUnreadCompletion = Boolean(
    completionKey &&
    input.conversation.isImported !== true &&
    !isCompletedRead(input.readState, completionKey) &&
    !hasActiveConversationOwner(input.queryKey, input.conversation.id)
  );
  const nextConversation: AgentGUIConversationSummary = {
    ...input.conversation,
    ...(title
      ? { title: title.title, titleFallback: title.titleFallback }
      : {}),
    hasUnreadCompletion,
    unreadCompletionKey: completionKey,
    status: input.conversation.status,
    updatedAtUnixMs: input.conversation.updatedAtUnixMs,
    pinnedAtUnixMs: input.conversation.pinnedAtUnixMs
  };
  return areConversationsEqual(input.conversation, nextConversation)
    ? input.conversation
    : nextConversation;
}

async function loadWorkspaceAgentSnapshotForConversations(input: {
  sessionOrigin: string;
  userId: string;
  workspaceId: string;
}): Promise<WorkspaceAgentActivitySnapshot> {
  const snapshot = await getAgentActivityRuntime().load(input.workspaceId);
  return workspaceAgentSnapshotForConversations(snapshot);
}

function getWorkspaceAgentSnapshotForConversations(input: {
  workspaceId: string;
}): WorkspaceAgentActivitySnapshot {
  const snapshot = getAgentActivityRuntime().getSnapshot(input.workspaceId);
  return workspaceAgentSnapshotForConversations(snapshot);
}

async function refreshAgentGUIConversationListQuery(
  query: AgentGUIConversationListQuery,
  reason: RefreshReason,
  options: ConversationListRefreshOptions = {}
): Promise<void> {
  const state = ensureQueryState(query);
  if (!state) {
    return;
  }
  const queryKey = state.queryKey;
  const requestId = (requestIdByQueryKey.get(queryKey) ?? 0) + 1;
  requestIdByQueryKey.set(queryKey, requestId);
  updateQueryState(query, (current) => {
    if (current.initialized) {
      return current.error === null ? current : { ...current, error: null };
    }
    if (current.isLoading && current.error === null) {
      return current;
    }
    return {
      ...current,
      isLoading: true,
      error: null
    };
  });

  try {
    const workspaceAgentsInput = {
      workspaceId: state.query.workspaceId,
      sessionOrigin: state.query.sessionOrigin,
      userId: state.query.userId
    };
    const workspaceAgentSnapshot =
      reason === "workspace-agent-update" || reason === "session-overlay-update"
        ? getWorkspaceAgentSnapshotForConversations(workspaceAgentsInput)
        : await loadWorkspaceAgentSnapshotForConversations(
            workspaceAgentsInput
          );
    if (requestId !== requestIdByQueryKey.get(queryKey)) {
      return;
    }
    const dirtySessionIds = consumePendingDirtySessionIds(queryKey);
    for (const sessionId of normalizeDirtySessionIds(options.dirtySessionIds)) {
      dirtySessionIds.add(sessionId);
    }
    const sessionViewDataById = workspaceSessionViewDataBySessionId(
      state.query.workspaceId
    );
    const sessionMessagesByIdForSummaries = mergeSessionMessagesById(
      workspaceAgentSnapshot.sessionMessagesById ?? {},
      nonEmptySessionMessagesById(
        workspaceAgentSnapshot.sessionMessagesById ?? {},
        sessionViewDataById
      )
    );
    const readState = await loadWorkspaceAgentReadState(state);
    if (requestId !== requestIdByQueryKey.get(queryKey)) {
      return;
    }
    const deletedConversationIds =
      deletedConversationIdsByQueryKey.get(queryKey) ?? new Set<string>();
    const localCreatedConversationIds =
      localCreatedConversationIdsByQueryKey.get(queryKey) ?? new Set<string>();
    const snapshotSessionIds = new Set(
      workspaceAgentSnapshot.sessions
        .map((session) => session.agentSessionId.trim())
        .filter((agentSessionId) => agentSessionId.length > 0)
    );
    const retainedSnapshotSessionIds = new Set(
      [...snapshotSessionIds].filter(
        (agentSessionId) => !deletedConversationIds.has(agentSessionId)
      )
    );
    for (const agentSessionId of retainedSnapshotSessionIds) {
      localCreatedConversationIds.delete(agentSessionId);
    }
    const nextDeletedConversationIds = new Set(
      [...deletedConversationIds].filter((agentSessionId) =>
        snapshotSessionIds.has(agentSessionId)
      )
    );
    deletedConversationIdsByQueryKey.set(queryKey, nextDeletedConversationIds);
    localCreatedConversationIdsByQueryKey.set(
      queryKey,
      localCreatedConversationIds
    );
    const currentConversations = getQueryState(query)?.conversations ?? [];
    const canApplyDirtySessionProjection =
      reason === "session-overlay-update" &&
      state.initialized &&
      dirtySessionIds.size > 0;
    const projectionSessions = canApplyDirtySessionProjection
      ? workspaceAgentSnapshot.sessions.filter((session) => {
          const agentSessionId = session.agentSessionId.trim();
          const syncSessionId = session.syncState?.agentSessionId?.trim() ?? "";
          return (
            (agentSessionId && dirtySessionIds.has(agentSessionId)) ||
            (syncSessionId && dirtySessionIds.has(syncSessionId))
          );
        })
      : workspaceAgentSnapshot.sessions;
    const baseConversations = buildAgentGUIConversationSummaries({
      snapshot: canApplyDirtySessionProjection
        ? {
            ...workspaceAgentSnapshot,
            sessions: projectionSessions
          }
        : workspaceAgentSnapshot,
      provider: state.query.provider,
      sessionMessagesById: sessionMessagesByIdForSummaries
    });
    const conversationsToDecorate = canApplyDirtySessionProjection
      ? new Set<string>([
          ...dirtySessionIds,
          ...baseConversations.map((conversation) => conversation.id)
        ])
      : null;
    const retainedSessionIds = new Set(retainedSnapshotSessionIds);
    if (reason === "workspace-agent-update") {
      for (const conversation of currentConversations) {
        if (!nextDeletedConversationIds.has(conversation.id)) {
          retainedSessionIds.add(conversation.id);
        }
      }
    }
    if (retainedSnapshotSessionIds.size > 0) {
      for (const agentSessionId of localCreatedConversationIds) {
        if (!nextDeletedConversationIds.has(agentSessionId)) {
          retainedSessionIds.add(agentSessionId);
        }
      }
    }

    if (canApplyDirtySessionProjection) {
      for (const conversation of currentConversations) {
        if (!nextDeletedConversationIds.has(conversation.id)) {
          retainedSessionIds.add(conversation.id);
        }
      }
    }

    const nextConversations = sortConversationsByRecency(
      mergeLoadedConversations(
        currentConversations,
        baseConversations,
        retainedSessionIds
      ).filter(
        (conversation) => !nextDeletedConversationIds.has(conversation.id)
      ),
      createConversationOrderIndex(currentConversations)
    ).map((conversation) => {
      if (
        conversationsToDecorate !== null &&
        !conversationsToDecorate.has(conversation.id)
      ) {
        return conversation;
      }
      const sessionViewData = sessionViewDataById[conversation.id];
      const mergedMessages =
        sessionMessagesByIdForSummaries[conversation.id] ??
        mergeWorkspaceAgentActivityDurableAndOverlayMessages({
          durableMessages:
            workspaceAgentSnapshot.sessionMessagesById?.[conversation.id],
          localMessages: sessionViewData?.overlayMessages
        });
      return decorateConversationForRefresh({
        conversation,
        mergedMessages,
        queryKey,
        readState
      });
    });

    updateQueryState(query, (current) => {
      const conversations = areConversationListsEqual(
        current.conversations,
        nextConversations
      )
        ? current.conversations
        : nextConversations;
      if (
        conversations === current.conversations &&
        current.isLoading === false &&
        current.initialized === true &&
        current.error === null
      ) {
        return current;
      }
      return {
        ...current,
        conversations,
        isLoading: false,
        initialized: true,
        error: null
      };
    });
  } catch (error) {
    if (requestId !== requestIdByQueryKey.get(queryKey)) {
      return;
    }
    const nextError = describeError(error);
    updateQueryState(query, (current) => {
      if (
        current.isLoading === false &&
        current.initialized === true &&
        current.error === nextError
      ) {
        return current;
      }
      return {
        ...current,
        isLoading: false,
        initialized: true,
        error: nextError
      };
    });
    throw error;
  }
}

function scheduleQueryRefresh(
  query: AgentGUIConversationListQuery,
  _reason: RefreshReason,
  options: ConversationListRefreshOptions = {}
): void {
  const state = ensureQueryState(query);
  if (!state) {
    return;
  }
  const queryKey = state.queryKey;
  addPendingDirtySessionIds(queryKey, options.dirtySessionIds);
  const delayMs =
    _reason === "projection-sync" && !state.initialized
      ? 0
      : REFRESH_DEBOUNCE_MS;
  const runRefresh = () => {
    refreshTimers.delete(queryKey);
    if (inflightRefreshByQueryKey.has(queryKey)) {
      needsRefreshAfterInflight.add(queryKey);
      return;
    }
    const promise = refreshAgentGUIConversationListQuery(
      state.query,
      _reason,
      options
    )
      .catch(() => undefined)
      .finally(() => {
        inflightRefreshByQueryKey.delete(queryKey);
        if (needsRefreshAfterInflight.has(queryKey)) {
          needsRefreshAfterInflight.delete(queryKey);
          scheduleQueryRefresh(state.query, "workspace-agent-update");
        }
      });
    inflightRefreshByQueryKey.set(queryKey, promise);
  };
  if (delayMs === 0) {
    runRefresh();
    return;
  }
  const existingTimer = refreshTimers.get(queryKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  refreshTimers.set(queryKey, setTimeout(runRefresh, delayMs));
}

function ensureWorkspaceAgentRuntimeRefresh(workspaceId: string): void {
  const normalizedWorkspaceId = workspaceId.trim();
  if (
    !normalizedWorkspaceId ||
    runtimeRefreshUnsubscribeByWorkspaceId.has(normalizedWorkspaceId)
  ) {
    return;
  }
  const runtime = getOptionalAgentActivityRuntime();
  if (!runtime) {
    return;
  }
  const unsubscribe = runtime.subscribe(normalizedWorkspaceId, () => {
    for (const state of Object.values(snapshot.statesByQueryKey)) {
      if (state.query.workspaceId !== normalizedWorkspaceId) {
        continue;
      }
      scheduleQueryRefresh(state.query, "workspace-agent-update");
    }
  });
  runtimeRefreshUnsubscribeByWorkspaceId.set(
    normalizedWorkspaceId,
    unsubscribe
  );
}

export function subscribeAgentGUIConversationListStore(
  listener: StoreListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentGUIConversationListStoreSnapshot(): AgentGUIConversationListStoreSnapshot {
  return snapshot;
}

export function getAgentGUIConversationListQuerySnapshot(
  query: AgentGUIConversationListQuery | null
): AgentGUIConversationListQueryState | null {
  return query ? getQueryState(query) : null;
}

export function getOrCreateAgentGUIConversationListQuerySnapshot(
  query: AgentGUIConversationListQuery | null
): AgentGUIConversationListQueryState | null {
  return query ? getOrCreateQueryState(query, { emitCreated: false }) : null;
}

export function ensureAgentGUIConversationListQuery(
  query: AgentGUIConversationListQuery
): void {
  ensureQueryState(query);
}

export function isAgentGUIConversationListRefreshing(
  query: AgentGUIConversationListQuery | null
): boolean {
  if (!query) return false;
  const key = createAgentGUIConversationListQueryKey(query);
  return key !== null && inflightRefreshByQueryKey.has(key);
}

export function getDeletedAgentGUIConversationIds(
  query: AgentGUIConversationListQuery | null
): ReadonlySet<string> {
  if (!query) return new Set();
  const key = createAgentGUIConversationListQueryKey(query);
  return key !== null
    ? (deletedConversationIdsByQueryKey.get(key) ?? new Set())
    : new Set();
}

export function scheduleAgentGUIConversationListProjection(
  query: AgentGUIConversationListQuery,
  reason: RefreshReason,
  options: ConversationListRefreshOptions = {}
): void {
  scheduleQueryRefresh(query, reason, options);
}

// Internal-only. Production callers must use the named, intent-scoped mutations
// below (patch a single conversation by id, remove by id, pin, seed, …). The
// arbitrary `(current[]) => next[]` updater was the seam that let a per-window
// view-derived value (project) be written back into the shared store and churn
// across windows; keeping it un-exported makes that impossible to express.
// `project` is a per-window JOIN of cwd x userProjects derived in the view layer;
// it must never become canonical store state (writing it back caused the
// cross-window update storm this module fixes). Strip it at the single write
// choke point so no path - merge, upsert, patch, seed - can leak a resolved
// project, regardless of what a caller returns. Returns the same array reference
// when nothing needed stripping, preserving the no-op identity short-circuit.
function stripProjectFromConversations(
  conversations: AgentGUIConversationSummary[]
): AgentGUIConversationSummary[] {
  let changed = false;
  const next = conversations.map((conversation) => {
    if (conversation.project == null) {
      return conversation;
    }
    changed = true;
    const { project: _project, ...rest } = conversation;
    return rest;
  });
  return changed ? next : conversations;
}

function updateAgentGUIConversationListConversations(
  query: AgentGUIConversationListQuery,
  updater: (
    current: AgentGUIConversationSummary[]
  ) => AgentGUIConversationSummary[],
  _reason: ConversationListUpdateReason = "external-update"
): void {
  updateQueryState(query, (current) => {
    const nextConversations = stripProjectFromConversations(
      updater(current.conversations)
    );
    if (nextConversations === current.conversations) {
      return current;
    }
    const previousOrderSource =
      current.conversations.length > 0
        ? current.conversations
        : nextConversations;
    const sortedConversations = sortConversationsByRecency(
      nextConversations,
      createConversationOrderIndex(previousOrderSource)
    );
    if (areConversationListsEqual(current.conversations, sortedConversations)) {
      return current;
    }
    recordConversationListUpdateDiagnostics({
      current,
      nextConversations: sortedConversations,
      reason: _reason
    });
    return {
      ...current,
      conversations: sortedConversations
    };
  });
}

export function setAgentGUIConversationListActiveConversation(input: {
  conversationId: string | null | undefined;
  ownerKey: string;
  query: AgentGUIConversationListQuery;
}): void {
  const ownerKey = input.ownerKey.trim();
  if (!ownerKey) {
    return;
  }
  const queryState = ensureQueryState(input.query);
  if (!queryState) {
    return;
  }
  const conversationId = input.conversationId?.trim() ?? "";
  const activeByOwner =
    activeConversationIdsByQueryKey.get(queryState.queryKey) ??
    new Map<string, string>();
  const previousConversationId = activeByOwner.get(ownerKey) ?? null;
  if (!conversationId) {
    if (previousConversationId === null) {
      return;
    }
    activeByOwner.delete(ownerKey);
    if (activeByOwner.size === 0) {
      activeConversationIdsByQueryKey.delete(queryState.queryKey);
    } else {
      activeConversationIdsByQueryKey.set(queryState.queryKey, activeByOwner);
    }
    return;
  }
  if (previousConversationId !== conversationId) {
    activeByOwner.set(ownerKey, conversationId);
    activeConversationIdsByQueryKey.set(queryState.queryKey, activeByOwner);
  }
  clearAgentGUIConversationUnreadCompletion({
    query: input.query,
    conversationId
  });
}

export function clearAgentGUIConversationUnreadCompletion(input: {
  conversationId: string;
  query: AgentGUIConversationListQuery;
}): void {
  const conversationId = input.conversationId.trim();
  if (!conversationId) {
    return;
  }
  const queryState = ensureQueryState(input.query);
  if (!queryState) {
    return;
  }
  const completionKey = queryState.conversations.find(
    (conversation) => conversation.id === conversationId
  )?.unreadCompletionKey;
  if (completionKey) {
    updateCompletedReadState(queryState, completionKey);
  }
  updateAgentGUIConversationListConversations(
    input.query,
    (current) => {
      let changed = false;
      const next = current.map((conversation) => {
        if (
          conversation.id !== conversationId ||
          conversation.hasUnreadCompletion !== true
        ) {
          return conversation;
        }
        changed = true;
        return {
          ...conversation,
          hasUnreadCompletion: false
        };
      });
      return changed ? next : current;
    },
    "active-conversation"
  );
}

export function markAgentGUIConversationCompletionObserved(input: {
  conversationId: string;
  completionKey?: string | null;
  allowReadyStatus?: boolean;
  query: AgentGUIConversationListQuery;
}): void {
  const conversationId = input.conversationId.trim();
  if (!conversationId) {
    return;
  }
  const queryState = ensureQueryState(input.query);
  if (!queryState) {
    return;
  }
  const shouldMarkUnread = !hasActiveConversationOwner(
    queryState.queryKey,
    conversationId
  );
  updateAgentGUIConversationListConversations(
    input.query,
    (current) => {
      let changed = false;
      const next = current.map((conversation) => {
        if (conversation.id !== conversationId) {
          return conversation;
        }
        const completionKey =
          normalizeCompletionKey(input.completionKey) ||
          (conversation.status === "completed"
            ? `session:${conversation.id}:completed`
            : "");
        if (!completionKey) {
          return conversation;
        }
        if (!shouldMarkUnread) {
          updateCompletedReadState(queryState, completionKey);
        }
        const canShowCompletion =
          conversation.status === "completed" ||
          input.allowReadyStatus === true;
        const hasUnreadCompletion =
          canShowCompletion &&
          conversation.isImported !== true &&
          shouldMarkUnread &&
          !isCompletedRead(
            readStateByQueryKey.get(queryState.queryKey) ??
              emptyWorkspaceAgentReadState(),
            completionKey
          );
        if (
          conversation.hasUnreadCompletion === hasUnreadCompletion &&
          conversation.unreadCompletionKey === completionKey
        ) {
          return conversation;
        }
        changed = true;
        return {
          ...conversation,
          hasUnreadCompletion,
          unreadCompletionKey: completionKey
        };
      });
      return changed ? next : current;
    },
    "completion-observed"
  );
}

export function upsertLocalCreatedAgentGUIConversation(input: {
  query: AgentGUIConversationListQuery;
  conversation: AgentGUIConversationSummary;
}): void {
  const queryState = ensureQueryState(input.query);
  if (!queryState) {
    return;
  }
  const localCreatedIds =
    localCreatedConversationIdsByQueryKey.get(queryState.queryKey) ??
    new Set<string>();
  localCreatedIds.add(input.conversation.id);
  deletedConversationIdsByQueryKey
    .get(queryState.queryKey)
    ?.delete(input.conversation.id);
  localCreatedConversationIdsByQueryKey.set(
    queryState.queryKey,
    localCreatedIds
  );
  updateAgentGUIConversationListConversations(
    input.query,
    (current) => upsertConversationOverlay(current, input.conversation),
    "local-created"
  );
}

export function setAgentGUIConversationPinned(input: {
  query: AgentGUIConversationListQuery;
  conversationId: string;
  pinnedAtUnixMs: number;
}): void {
  const conversationId = input.conversationId.trim();
  if (!conversationId) {
    return;
  }
  updateAgentGUIConversationListConversations(
    input.query,
    (current) =>
      current.some((conversation) => conversation.id === conversationId)
        ? current.map((conversation) => {
            if (conversation.id !== conversationId) {
              return conversation;
            }
            const pinnedAtUnixMs = Math.max(0, input.pinnedAtUnixMs);
            return (conversation.pinnedAtUnixMs ?? 0) === pinnedAtUnixMs
              ? conversation
              : {
                  ...conversation,
                  pinnedAtUnixMs
                };
          })
        : current,
    "pin-changed"
  );
}

/**
 * Apply a partial update to a single conversation identified by id. `patch` is
 * either a partial object or a function `(conversation) => Partial | null`
 * (return `null` for "no change"). Unlike the (now internal) arbitrary list
 * updater, this can only modify fields of ONE existing conversation — it cannot
 * add, remove, reorder, or bulk-rewrite the list. That constraint is what makes
 * a view-derived writeback (the old project storm) impossible to express.
 */
export function patchAgentGUIConversationSummary(input: {
  query: AgentGUIConversationListQuery;
  conversationId: string;
  // `project` is omitted from the patch type: it is view-derived, never store
  // state. (Even if it slipped through, stripProjectFromConversations drops it.)
  patch:
    | Partial<Omit<AgentGUIConversationSummary, "project">>
    | ((
        conversation: AgentGUIConversationSummary
      ) => Partial<Omit<AgentGUIConversationSummary, "project">> | null);
}): void {
  const conversationId = input.conversationId.trim();
  if (!conversationId) {
    return;
  }
  updateAgentGUIConversationListConversations(input.query, (current) => {
    if (!current.some((conversation) => conversation.id === conversationId)) {
      return current;
    }
    let changed = false;
    const next = current.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const patch =
        typeof input.patch === "function"
          ? input.patch(conversation)
          : input.patch;
      if (!patch) {
        return conversation;
      }
      const merged = { ...conversation, ...patch };
      if (areConversationsEqual(conversation, merged)) {
        return conversation;
      }
      changed = true;
      return merged;
    });
    return changed ? next : current;
  });
}

/** Remove conversations by id (optimistic local delete, no reappear-guard). */
export function removeAgentGUIConversationSummaries(input: {
  query: AgentGUIConversationListQuery;
  conversationIds: readonly string[];
}): void {
  const ids = new Set(
    input.conversationIds.map((id) => id.trim()).filter(Boolean)
  );
  if (ids.size === 0) {
    return;
  }
  updateAgentGUIConversationListConversations(
    input.query,
    (current) => {
      const next = current.filter((conversation) => !ids.has(conversation.id));
      return next.length === current.length ? current : next;
    },
    "local-delete"
  );
}

/**
 * Seed a query's conversations from a previous snapshot ONLY when the target is
 * still empty (query-key/userId handoff). One-shot and gated, so it cannot churn
 * across windows.
 */
export function seedAgentGUIConversationListConversationsIfEmpty(input: {
  query: AgentGUIConversationListQuery;
  conversations: readonly AgentGUIConversationSummary[];
}): void {
  if (input.conversations.length === 0) {
    return;
  }
  updateAgentGUIConversationListConversations(input.query, (current) =>
    current.length === 0 ? [...input.conversations] : current
  );
}

export function markAgentGUIConversationCreatePending(input: {
  query: AgentGUIConversationListQuery;
  ownerKey: string;
  conversationId: string;
}): void {
  if (
    markAgentGUIConversationCreatePendingState({
      queryKey: createAgentGUIConversationListQueryKey(input.query),
      ownerKey: input.ownerKey,
      conversationId: input.conversationId
    })
  ) {
    emitChange();
  }
}

export function clearAgentGUIConversationCreatePending(input: {
  query: AgentGUIConversationListQuery;
  ownerKey: string;
  conversationId?: string | null;
}): void {
  if (
    clearAgentGUIConversationCreatePendingState({
      queryKey: createAgentGUIConversationListQueryKey(input.query),
      ownerKey: input.ownerKey,
      conversationId: input.conversationId
    })
  ) {
    emitChange();
  }
}

export function getAgentGUIConversationCreatePending(input: {
  query: AgentGUIConversationListQuery;
  ownerKey: string;
}): string | null {
  return getAgentGUIConversationCreatePendingState({
    queryKey: createAgentGUIConversationListQueryKey(input.query),
    ownerKey: input.ownerKey
  });
}

export function markAgentGUIConversationSubmitPending(input: {
  query: AgentGUIConversationListQuery;
  conversationId: string;
}): void {
  if (
    markAgentGUIConversationSubmitPendingState({
      queryKey: createAgentGUIConversationListQueryKey(input.query),
      conversationId: input.conversationId
    })
  ) {
    updateAgentGUIConversationListConversations(
      input.query,
      (current) =>
        current.map((conversation) =>
          conversation.id === input.conversationId.trim()
            ? {
                ...conversation,
                status: "working",
                updatedAtUnixMs: Date.now()
              }
            : conversation
        ),
      "submit-pending"
    );
    emitChange();
  }
}

export function clearAgentGUIConversationSubmitPending(input: {
  query: AgentGUIConversationListQuery;
  conversationId: string;
}): void {
  if (
    clearAgentGUIConversationSubmitPendingState({
      queryKey: createAgentGUIConversationListQueryKey(input.query),
      conversationId: input.conversationId
    })
  ) {
    emitChange();
  }
}

export function getAgentGUIConversationSubmitPending(input: {
  query: AgentGUIConversationListQuery;
  conversationId: string | null | undefined;
}): boolean {
  return getAgentGUIConversationSubmitPendingState({
    queryKey: createAgentGUIConversationListQueryKey(input.query),
    conversationId: input.conversationId
  });
}

export function markLocalDeletedAgentGUIConversation(input: {
  query: AgentGUIConversationListQuery;
  agentSessionId: string;
}): void {
  const queryState = ensureQueryState(input.query);
  if (!queryState) {
    return;
  }
  const deletedIds =
    deletedConversationIdsByQueryKey.get(queryState.queryKey) ??
    new Set<string>();
  deletedIds.add(input.agentSessionId);
  deletedConversationIdsByQueryKey.set(queryState.queryKey, deletedIds);
  const localCreatedIds =
    localCreatedConversationIdsByQueryKey.get(queryState.queryKey) ??
    new Set<string>();
  localCreatedIds.delete(input.agentSessionId);
  localCreatedConversationIdsByQueryKey.set(
    queryState.queryKey,
    localCreatedIds
  );
  updateAgentGUIConversationListConversations(
    input.query,
    (current) =>
      current.filter(
        (conversation) => conversation.id !== input.agentSessionId
      ),
    "local-delete"
  );
}

/**
 * Test-only seam: replace a query's conversations wholesale. Production code must
 * use the named single-conversation mutations; this exists so store-level tests
 * can seed arbitrary lists and exercise sort/equality/diagnostics behaviour.
 */
export function setAgentGUIConversationListConversationsForTests(
  query: AgentGUIConversationListQuery,
  conversations: AgentGUIConversationSummary[]
): void {
  updateAgentGUIConversationListConversations(
    query,
    () => conversations,
    "external-update"
  );
}

export function resetAgentGUIConversationListStoreForTests(): void {
  for (const unsubscribe of runtimeRefreshUnsubscribeByWorkspaceId.values()) {
    unsubscribe();
  }
  runtimeRefreshUnsubscribeByWorkspaceId.clear();
  for (const timer of refreshTimers.values()) {
    clearTimeout(timer);
  }
  refreshTimers.clear();
  inflightRefreshByQueryKey.clear();
  needsRefreshAfterInflight.clear();
  pendingDirtySessionIdsByQueryKey.clear();
  requestIdByQueryKey.clear();
  localCreatedConversationIdsByQueryKey.clear();
  readStateByQueryKey.clear();
  readStateLoadByQueryKey.clear();
  resetAgentGUIConversationPendingStateForTests();
  deletedConversationIdsByQueryKey.clear();
  activeConversationIdsByQueryKey.clear();
  updateStormDiagnosticsByQueryKey.clear();
  snapshot = EMPTY_SNAPSHOT;
  emitChange();
}
