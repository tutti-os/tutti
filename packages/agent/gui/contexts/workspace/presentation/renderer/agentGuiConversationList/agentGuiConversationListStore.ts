import { mergeAgentActivityMessages } from "@tutti-os/agent-activity-core";
import {
  getAgentActivityRuntime,
  getOptionalAgentActivityRuntime
} from "../../../../../agentActivityRuntime";
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
  | "workspace-agent-update";

const EMPTY_SNAPSHOT: AgentGUIConversationListStoreSnapshot = {
  statesByQueryKey: {}
};

let snapshot: AgentGUIConversationListStoreSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<StoreListener>();
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inflightRefreshByQueryKey = new Map<string, Promise<void>>();
const needsRefreshAfterInflight = new Set<string>();
const requestIdByQueryKey = new Map<string, number>();
const localCreatedConversationIdsByQueryKey = new Map<string, Set<string>>();
const deletedConversationIdsByQueryKey = new Map<string, Set<string>>();
const runtimeRefreshUnsubscribeByWorkspaceId = new Map<string, () => void>();
const activeConversationIdsByQueryKey = new Map<string, Map<string, string>>();

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
  const project =
    incoming.project ??
    (current?.cwd === incoming.cwd ? current?.project : null);
  const merged: AgentGUIConversationSummary = {
    ...incoming,
    ...mergeLoadedConversationTitleFields(current, incoming, preferCurrent),
    hasUnreadCompletion:
      incoming.hasUnreadCompletion ||
      (preferCurrent ? current?.hasUnreadCompletion : false),
    pinnedAtUnixMs,
    project,
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
    left.hasUnreadCompletion === right.hasUnreadCompletion &&
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
  reason: RefreshReason
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
      reason === "workspace-agent-update"
        ? getWorkspaceAgentSnapshotForConversations(workspaceAgentsInput)
        : await loadWorkspaceAgentSnapshotForConversations(
            workspaceAgentsInput
          );
    if (requestId !== requestIdByQueryKey.get(queryKey)) {
      return;
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
    const baseConversations = buildAgentGUIConversationSummaries({
      snapshot: workspaceAgentSnapshot,
      provider: state.query.provider,
      sessionMessagesById: sessionMessagesByIdForSummaries
    });

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
      const sessionViewData = sessionViewDataById[conversation.id];
      const mergedMessages =
        sessionMessagesByIdForSummaries[conversation.id] ??
        mergeWorkspaceAgentActivityDurableAndOverlayMessages({
          durableMessages:
            workspaceAgentSnapshot.sessionMessagesById?.[conversation.id],
          localMessages: sessionViewData?.overlayMessages
        });
      const title = resolveAgentGUIConversationTitleFromMessages({
        messages: mergedMessages,
        conversation
      });
      return {
        ...conversation,
        ...(title
          ? { title: title.title, titleFallback: title.titleFallback }
          : {}),
        status: conversation.status,
        updatedAtUnixMs: conversation.updatedAtUnixMs,
        pinnedAtUnixMs: conversation.pinnedAtUnixMs
      };
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
  _reason: RefreshReason
): void {
  const state = ensureQueryState(query);
  if (!state) {
    return;
  }
  const queryKey = state.queryKey;
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
    const promise = refreshAgentGUIConversationListQuery(state.query, _reason)
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

export function scheduleAgentGUIConversationListProjection(
  query: AgentGUIConversationListQuery,
  reason: RefreshReason
): void {
  scheduleQueryRefresh(query, reason);
}

export function updateAgentGUIConversationListConversations(
  query: AgentGUIConversationListQuery,
  updater: (
    current: AgentGUIConversationSummary[]
  ) => AgentGUIConversationSummary[]
): void {
  updateQueryState(query, (current) => {
    const nextConversations = updater(current.conversations);
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
  updateAgentGUIConversationListConversations(input.query, (current) => {
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
  });
}

export function markAgentGUIConversationCompletionObserved(input: {
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
  const shouldMarkUnread = !hasActiveConversationOwner(
    queryState.queryKey,
    conversationId
  );
  updateAgentGUIConversationListConversations(input.query, (current) => {
    let changed = false;
    const next = current.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const hasUnreadCompletion =
        conversation.status === "completed" && shouldMarkUnread;
      if (conversation.hasUnreadCompletion === hasUnreadCompletion) {
        return conversation;
      }
      changed = true;
      return {
        ...conversation,
        hasUnreadCompletion
      };
    });
    return changed ? next : current;
  });
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
  updateAgentGUIConversationListConversations(input.query, (current) =>
    upsertConversationOverlay(current, input.conversation)
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
  updateAgentGUIConversationListConversations(input.query, (current) =>
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
      : current
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
    updateAgentGUIConversationListConversations(input.query, (current) =>
      current.map((conversation) =>
        conversation.id === input.conversationId.trim()
          ? {
              ...conversation,
              status: "working",
              updatedAtUnixMs: Date.now()
            }
          : conversation
      )
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
  updateAgentGUIConversationListConversations(input.query, (current) =>
    current.filter((conversation) => conversation.id !== input.agentSessionId)
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
  requestIdByQueryKey.clear();
  localCreatedConversationIdsByQueryKey.clear();
  resetAgentGUIConversationPendingStateForTests();
  deletedConversationIdsByQueryKey.clear();
  activeConversationIdsByQueryKey.clear();
  snapshot = EMPTY_SNAPSHOT;
  emitChange();
}
