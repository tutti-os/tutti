import type { SetStateAction } from "react";
import { proxy } from "valtio/vanilla";
import type {
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerNodeState,
  IssueManagerOpenSource,
  IssueManagerOpenTrigger,
  IssueManagerTaskDetail,
  IssueManagerTopic
} from "../../contracts/index.ts";
import {
  normalizeIssueManagerNodeState,
  type IssueManagerFeature
} from "../../core/index.ts";
import {
  logIssueManagerDiagnostic,
  type IssueManagerDiagnostics
} from "../../internal/issueManagerDiagnostics.ts";
import { resolveIssueManagerErrorMessage } from "./controllerUtils.ts";
import {
  applyIssueManagerIssueDetailResultToNodeState,
  applyIssueManagerIssueListResultToNodeState,
  createIssueManagerIssueDraftFromNodeState,
  createIssueManagerTaskDraftFromNodeState,
  syncIssueManagerIssueDraftFromDetail,
  syncIssueManagerTaskDraftFromDetail
} from "./controllerState.ts";
import type {
  AsyncCollectionState,
  IssueDraft,
  IssueManagerNotificationState,
  TaskDraft
} from "./controllerTypes.ts";
import type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "./model.ts";

export interface IssueManagerControllerSnapshot {
  issueDetail: AsyncCollectionState<IssueManagerIssueDetail | null>;
  issueDraft: IssueDraft;
  issueEditorMode: IssueManagerEditorMode;
  issues: AsyncCollectionState<IssueManagerIssueSummary[]>;
  isRunningTask: boolean;
  nodeState: IssueManagerNodeState;
  notification: IssueManagerNotificationState | null;
  referenceTarget: IssueManagerReferenceTarget | null;
  taskDetail: AsyncCollectionState<IssueManagerTaskDetail | null>;
  taskDraft: TaskDraft;
  taskEditorMode: IssueManagerEditorMode;
  topics: AsyncCollectionState<IssueManagerTopic[]>;
}

export interface CreateIssueManagerControllerRuntimeInput {
  diagnostics?: IssueManagerDiagnostics | null;
  feature: IssueManagerFeature;
  openSource?: IssueManagerOpenSource;
  state?: Partial<IssueManagerNodeState> | null;
  workspaceId: string;
}

function createIssueManagerOpenedParams(source: IssueManagerOpenSource): {
  source: IssueManagerOpenSource;
  trigger: IssueManagerOpenTrigger;
} {
  return {
    source,
    trigger:
      source === "restore" || source === "agent_command"
        ? "automatic"
        : "manual"
  };
}

export interface SyncIssueManagerControllerRuntimeInput {
  deferredIssueSearch: string;
  onStateChange?: (state: IssueManagerNodeState) => void;
  taskListCollapsed: boolean;
}

export interface IssueManagerControllerRuntime {
  getSnapshot(): IssueManagerControllerSnapshot;
  refreshAll(): void;
  refreshDetails(): void;
  release(): void;
  reportIssueSearchUsage(query: string): void;
  retain(): void;
  readonly store: IssueManagerControllerSnapshot;
  setIsRunningTask(update: SetStateAction<boolean>): void;
  setIssueDraftInternal(update: SetStateAction<IssueDraft>): void;
  setIssueEditorModeState(update: SetStateAction<IssueManagerEditorMode>): void;
  setReferenceTarget(
    update: SetStateAction<IssueManagerReferenceTarget | null>
  ): void;
  setNotification(
    update: SetStateAction<IssueManagerNotificationState | null>
  ): void;
  setTaskDraftInternal(update: SetStateAction<TaskDraft>): void;
  setTaskEditorModeState(update: SetStateAction<IssueManagerEditorMode>): void;
  subscribe(listener: () => void): () => void;
  syncInput(input: SyncIssueManagerControllerRuntimeInput): void;
  updateNodeState(
    updater:
      | Partial<IssueManagerNodeState>
      | ((current: IssueManagerNodeState) => IssueManagerNodeState)
  ): void;
}

export function createIssueManagerControllerRuntime(
  input: CreateIssueManagerControllerRuntimeInput
): IssueManagerControllerRuntime {
  const diagnostics = input.diagnostics ?? null;
  const normalizedNodeState = normalizeIssueManagerNodeState(input.state);
  const listeners = new Set<() => void>();
  let deferredIssueSearch = normalizedNodeState.issueSearchQuery;
  let issueDetailSequence = 0;
  let issueListSequence = 0;
  let lastResolvedIssueSearchQuery: string | null = null;
  let hasReportedOpened = false;
  let onStateChange: ((state: IssueManagerNodeState) => void) | undefined;
  let pendingIssueSearchAnalyticsQuery: string | null = null;
  let refCount = 0;
  let retained = false;
  let taskDetailSequence = 0;
  let topicListSequence = 0;
  let unsubscribeIssueUpdates: (() => void) | null = null;
  let snapshot: IssueManagerControllerSnapshot = {
    issueDetail: createAsyncCollectionState<IssueManagerIssueDetail | null>(
      null
    ),
    issueDraft: createIssueManagerIssueDraftFromNodeState(normalizedNodeState),
    issueEditorMode: "read",
    issues: createAsyncCollectionState<IssueManagerIssueSummary[]>([], {
      hasResolved: false
    }),
    isRunningTask: false,
    nodeState: normalizedNodeState,
    notification: null,
    referenceTarget: null,
    taskDetail: createAsyncCollectionState<IssueManagerTaskDetail | null>(null),
    taskDraft: createIssueManagerTaskDraftFromNodeState(normalizedNodeState),
    taskEditorMode: "read",
    topics: createAsyncCollectionState<IssueManagerTopic[]>([], {
      hasResolved: false
    })
  };
  const store = proxy(snapshot);

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const setSnapshot = (
    updater:
      | Partial<IssueManagerControllerSnapshot>
      | ((
          current: IssueManagerControllerSnapshot
        ) => IssueManagerControllerSnapshot)
  ) => {
    const next =
      typeof updater === "function"
        ? updater(snapshot)
        : {
            ...snapshot,
            ...updater
          };
    if (next === snapshot) {
      return;
    }
    snapshot = next;
    Object.assign(store, next);
    notify();
  };

  const syncIssueDraftFromCurrentDetail = () => {
    const nextIssueDraft = syncIssueManagerIssueDraftFromDetail(
      snapshot.issueDraft,
      snapshot.issueDetail.value,
      snapshot.issueEditorMode
    );
    if (nextIssueDraft === snapshot.issueDraft) {
      return;
    }
    setSnapshot((current) => ({
      ...current,
      issueDraft: nextIssueDraft
    }));
  };

  const syncTaskDraftFromCurrentDetail = () => {
    const nextTaskDraft = syncIssueManagerTaskDraftFromDetail(
      snapshot.taskDraft,
      snapshot.taskDetail.value,
      snapshot.taskEditorMode
    );
    if (nextTaskDraft === snapshot.taskDraft) {
      return;
    }
    setSnapshot((current) => ({
      ...current,
      taskDraft: nextTaskDraft
    }));
  };

  const applyNodeState = (
    updater:
      | Partial<IssueManagerNodeState>
      | ((current: IssueManagerNodeState) => IssueManagerNodeState)
  ) => {
    const previous = snapshot.nodeState;
    const next =
      typeof updater === "function"
        ? updater(previous)
        : ({
            ...previous,
            ...updater
          } satisfies IssueManagerNodeState);
    if (next === previous) {
      return;
    }

    if (
      previous.activeTopicId !== next.activeTopicId ||
      previous.selectedIssueId !== next.selectedIssueId ||
      previous.selectedTaskId !== next.selectedTaskId ||
      previous.taskListCollapsed !== next.taskListCollapsed
    ) {
      logIssueManagerDiagnostic(
        diagnostics,
        "node_state.changed",
        {
          nextActiveTopicId: next.activeTopicId ?? null,
          nextSelectedIssueId: next.selectedIssueId,
          nextSelectedTaskId: next.selectedTaskId,
          nextTaskListCollapsed: next.taskListCollapsed === true,
          previousActiveTopicId: previous.activeTopicId ?? null,
          previousSelectedIssueId: previous.selectedIssueId,
          previousSelectedTaskId: previous.selectedTaskId,
          previousTaskListCollapsed: previous.taskListCollapsed === true
        },
        { includeStack: true }
      );
    }

    setSnapshot((current) => ({
      ...current,
      nodeState: next
    }));
    onStateChange?.(next);
    handleNodeStateTransition(previous, next);
  };

  const loadTopics = async () => {
    const sequence = ++topicListSequence;
    setSnapshot((current) => ({
      ...current,
      topics: {
        ...current.topics,
        error: null,
        isLoading: true
      }
    }));

    try {
      const result = await input.feature.backend.listTopics({
        workspaceId: input.workspaceId
      });
      if (!retained || sequence !== topicListSequence) {
        return;
      }
      if (result.topics.length === 0) {
        throw new Error(input.feature.i18n.t("messages.topicListEmpty"));
      }

      setSnapshot((current) => ({
        ...current,
        topics: {
          error: null,
          hasResolved: true,
          isLoading: false,
          value: result.topics
        }
      }));
      const currentActiveTopicId = snapshot.nodeState.activeTopicId;
      const currentTopicExists = result.topics.some(
        (topic) => topic.topicId === currentActiveTopicId
      );
      const activeTopicId = currentTopicExists
        ? currentActiveTopicId
        : (result.topics[0]?.topicId ?? null);
      applyNodeState({
        activeTopicId
      });
      if (activeTopicId && activeTopicId === currentActiveTopicId) {
        void loadIssues();
      }
    } catch (error) {
      if (!retained || sequence !== topicListSequence) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        topics: {
          error: resolveIssueManagerErrorMessage(error, input.feature.i18n),
          hasResolved: true,
          isLoading: false,
          value: []
        }
      }));
    }
  };

  const trackIssueSearchAnalytics = (
    inputValue: string,
    resultCount: number
  ) => {
    const query = inputValue.trim();
    if (!query) {
      return;
    }
    void Promise.resolve(
      input.feature.analytics?.track({
        name: "issue_manager.task_searched",
        params: {
          queryLength: query.length,
          resultCount
        }
      })
    ).catch(() => undefined);
  };

  const flushPendingIssueSearchAnalytics = (
    searchQuery: string,
    resultCount: number
  ) => {
    if (pendingIssueSearchAnalyticsQuery !== searchQuery || !searchQuery) {
      return;
    }
    pendingIssueSearchAnalyticsQuery = null;
    trackIssueSearchAnalytics(searchQuery, resultCount);
  };

  const loadIssues = async () => {
    const searchQuery = deferredIssueSearch.trim();
    const activeTopicId = snapshot.nodeState.activeTopicId;
    const sequence = ++issueListSequence;
    if (!activeTopicId) {
      lastResolvedIssueSearchQuery = searchQuery;
      setSnapshot((current) => ({
        ...current,
        issues: {
          error: null,
          hasResolved: true,
          isLoading: false,
          value: []
        }
      }));
      flushPendingIssueSearchAnalytics(searchQuery, 0);
      return;
    }
    setSnapshot((current) => ({
      ...current,
      issues: {
        ...current.issues,
        error: null,
        isLoading: true
      }
    }));

    try {
      const listIssues = (
        statusFilter: IssueManagerNodeState["issueStatusFilter"]
      ) =>
        input.feature.backend.listIssues({
          searchQuery: searchQuery || undefined,
          statusFilter,
          topicId: activeTopicId,
          workspaceId: input.workspaceId
        });
      const result = await listIssues(snapshot.nodeState.issueStatusFilter);
      if (!retained || sequence !== issueListSequence) {
        return;
      }

      lastResolvedIssueSearchQuery = searchQuery;
      setSnapshot((current) => ({
        ...current,
        issues: {
          error: null,
          hasResolved: true,
          isLoading: false,
          statusCounts: result.statusCounts ?? current.issues.statusCounts,
          value: result.issues
        }
      }));
      applyNodeState((current) =>
        applyIssueManagerIssueListResultToNodeState(current, result)
      );
      flushPendingIssueSearchAnalytics(searchQuery, result.issues.length);
    } catch (error) {
      if (!retained || sequence !== issueListSequence) {
        return;
      }
      setSnapshot((current) => ({
        ...current,
        issues: {
          error: resolveIssueManagerErrorMessage(error, input.feature.i18n),
          hasResolved: true,
          isLoading: false,
          statusCounts: current.issues.statusCounts,
          value: []
        }
      }));
    }
  };

  const clearIssueDetail = () => {
    setSnapshot((current) => ({
      ...current,
      issueDetail: createAsyncCollectionState<IssueManagerIssueDetail | null>(
        null
      )
    }));
    syncIssueDraftFromCurrentDetail();
  };

  const clearTaskDetail = () => {
    setSnapshot((current) => ({
      ...current,
      taskDetail: createAsyncCollectionState<IssueManagerTaskDetail | null>(
        null
      )
    }));
    syncTaskDraftFromCurrentDetail();
  };

  const loadIssueDetail = async () => {
    const selectedIssueId = snapshot.nodeState.selectedIssueId;
    issueDetailSequence += 1;
    const sequence = issueDetailSequence;
    if (!selectedIssueId) {
      clearIssueDetail();
      clearTaskDetail();
      return;
    }

    setSnapshot((current) => ({
      ...current,
      issueDetail: {
        ...current.issueDetail,
        error: null,
        isLoading: true
      }
    }));

    try {
      const result = await input.feature.backend.getIssueDetail({
        issueId: selectedIssueId,
        workspaceId: input.workspaceId
      });
      if (!retained || sequence !== issueDetailSequence) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        issueDetail: {
          error: null,
          isLoading: false,
          value: result
        }
      }));
      syncIssueDraftFromCurrentDetail();
      applyNodeState((current) =>
        applyIssueManagerIssueDetailResultToNodeState(current, result)
      );
    } catch (error) {
      if (!retained || sequence !== issueDetailSequence) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        issueDetail: {
          error: resolveIssueManagerErrorMessage(error, input.feature.i18n),
          isLoading: false,
          value: null
        }
      }));
      syncIssueDraftFromCurrentDetail();
    }
  };

  const loadTaskDetail = async () => {
    const selectedIssueId = snapshot.nodeState.selectedIssueId;
    const selectedTaskId = snapshot.nodeState.selectedTaskId;
    taskDetailSequence += 1;
    const sequence = taskDetailSequence;
    if (!selectedIssueId || !selectedTaskId) {
      clearTaskDetail();
      return;
    }

    setSnapshot((current) => ({
      ...current,
      taskDetail: {
        ...current.taskDetail,
        error: null,
        isLoading: true
      }
    }));

    try {
      const result = await input.feature.backend.getTaskDetail({
        issueId: selectedIssueId,
        taskId: selectedTaskId,
        workspaceId: input.workspaceId
      });
      if (!retained || sequence !== taskDetailSequence) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        taskDetail: {
          error: null,
          isLoading: false,
          value: result
        }
      }));
      syncTaskDraftFromCurrentDetail();
    } catch (error) {
      if (!retained || sequence !== taskDetailSequence) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        taskDetail: {
          error: resolveIssueManagerErrorMessage(error, input.feature.i18n),
          isLoading: false,
          value: null
        }
      }));
      syncTaskDraftFromCurrentDetail();
    }
  };

  const handleNodeStateTransition = (
    previous: IssueManagerNodeState,
    next: IssueManagerNodeState
  ) => {
    if (!retained) {
      return;
    }

    if (previous.activeTopicId !== next.activeTopicId && next.activeTopicId) {
      applyNodeState({
        selectedIssueId: null,
        selectedTaskId: null
      });
      void loadIssues();
      return;
    }

    if (
      previous.issueStatusFilter !== next.issueStatusFilter &&
      deferredIssueSearch === snapshot.nodeState.issueSearchQuery
    ) {
      void loadIssues();
    }

    if (previous.selectedIssueId !== next.selectedIssueId) {
      void loadIssueDetail();
      return;
    }

    if (previous.selectedTaskId !== next.selectedTaskId) {
      void loadTaskDetail();
    }
  };

  const retainIssueUpdates = () => {
    if (unsubscribeIssueUpdates || !input.feature.eventSource) {
      return;
    }
    unsubscribeIssueUpdates = input.feature.eventSource.subscribeToIssueUpdates(
      input.workspaceId,
      (event) => {
        if (event.workspaceId.trim() !== input.workspaceId.trim()) {
          return;
        }
        void loadTopics();
        void loadIssueDetail();
        void loadTaskDetail();
      }
    );
    try {
      const connectResult = input.feature.eventSource.connect?.();
      if (connectResult) {
        void connectResult.catch(() => {});
      }
    } catch {
      // Keep the controller usable when the event stream is temporarily down.
    }
  };

  const releaseIssueUpdates = () => {
    unsubscribeIssueUpdates?.();
    unsubscribeIssueUpdates = null;
  };

  return {
    getSnapshot() {
      return snapshot;
    },
    refreshAll() {
      if (!retained) {
        return;
      }
      void loadTopics();
      void loadIssueDetail();
      void loadTaskDetail();
    },
    refreshDetails() {
      if (!retained) {
        return;
      }
      void loadIssueDetail();
      void loadTaskDetail();
    },
    release() {
      refCount = Math.max(0, refCount - 1);
      if (refCount > 0) {
        return;
      }
      retained = false;
      issueListSequence += 1;
      issueDetailSequence += 1;
      taskDetailSequence += 1;
      topicListSequence += 1;
      releaseIssueUpdates();
    },
    reportIssueSearchUsage(query) {
      const searchQuery = query.trim();
      if (!searchQuery) {
        return;
      }
      pendingIssueSearchAnalyticsQuery = searchQuery;
      if (
        lastResolvedIssueSearchQuery === searchQuery &&
        !snapshot.issues.isLoading
      ) {
        flushPendingIssueSearchAnalytics(
          searchQuery,
          snapshot.issues.value.length
        );
      }
    },
    retain() {
      refCount += 1;
      if (retained) {
        return;
      }
      retained = true;
      if (!hasReportedOpened) {
        hasReportedOpened = true;
        void Promise.resolve(
          input.feature.analytics?.track({
            name: "issue_manager.opened",
            params: createIssueManagerOpenedParams(
              input.openSource ?? "restore"
            )
          })
        ).catch(() => undefined);
      }
      retainIssueUpdates();
      void loadTopics();
      void loadIssueDetail();
      void loadTaskDetail();
    },
    setIsRunningTask(update) {
      setSnapshot((current) => ({
        ...current,
        isRunningTask: resolveSetStateAction(update, current.isRunningTask)
      }));
    },
    setIssueDraftInternal(update) {
      setSnapshot((current) => ({
        ...current,
        issueDraft: resolveSetStateAction(update, current.issueDraft)
      }));
    },
    setIssueEditorModeState(update) {
      const nextMode = resolveSetStateAction(update, snapshot.issueEditorMode);
      setSnapshot((current) => ({
        ...current,
        issueEditorMode: nextMode
      }));
      syncIssueDraftFromCurrentDetail();
    },
    setReferenceTarget(update) {
      setSnapshot((current) => ({
        ...current,
        referenceTarget: resolveSetStateAction(update, current.referenceTarget)
      }));
    },
    setNotification(update) {
      setSnapshot((current) => ({
        ...current,
        notification: resolveSetStateAction(update, current.notification)
      }));
    },
    setTaskDraftInternal(update) {
      setSnapshot((current) => ({
        ...current,
        taskDraft: resolveSetStateAction(update, current.taskDraft)
      }));
    },
    setTaskEditorModeState(update) {
      const nextMode = resolveSetStateAction(update, snapshot.taskEditorMode);
      setSnapshot((current) => ({
        ...current,
        taskEditorMode: nextMode
      }));
      syncTaskDraftFromCurrentDetail();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    syncInput(nextInput) {
      onStateChange = nextInput.onStateChange;
      if (deferredIssueSearch !== nextInput.deferredIssueSearch) {
        deferredIssueSearch = nextInput.deferredIssueSearch;
        if (retained) {
          void loadIssues();
        }
      }

      if (
        (snapshot.nodeState.taskListCollapsed === true) !==
        nextInput.taskListCollapsed
      ) {
        applyNodeState((current) => ({
          ...current,
          taskListCollapsed: nextInput.taskListCollapsed
        }));
      }
    },
    updateNodeState(updater) {
      applyNodeState(updater);
    },
    store
  };
}

function createAsyncCollectionState<TValue>(
  value: TValue,
  options?: Pick<AsyncCollectionState<TValue>, "hasResolved">
): AsyncCollectionState<TValue> {
  return {
    error: null,
    ...options,
    isLoading: false,
    value
  };
}

function resolveSetStateAction<TValue>(
  update: SetStateAction<TValue>,
  current: TValue
): TValue {
  return typeof update === "function"
    ? (update as (value: TValue) => TValue)(current)
    : update;
}
