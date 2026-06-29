import { useEffect, useEffectEvent, useState } from "react";
import type {
  IssueManagerIssueSummary,
  IssueManagerTaskSummary,
  IssueManagerCreateTopicInput,
  IssueManagerTopic,
  IssueManagerUpdateTopicInput
} from "../../../../contracts/index.ts";
import type { IssueManagerI18nRuntime } from "../../../../i18n/issueManagerI18n.ts";

interface IssueManagerTaskListCollapsedDetail {
  collapsed: boolean;
  nodeId: string;
  workspaceId: string;
}

const issueManagerTaskListCollapsedEvent =
  "tutti:issue-manager-task-list-collapsed";

type IssueManagerTopicCreateEventInput = Omit<
  IssueManagerCreateTopicInput,
  "workspaceId"
>;

type IssueManagerTopicUpdateEventInput = Omit<
  IssueManagerUpdateTopicInput,
  "workspaceId"
>;

interface IssueManagerTopicHeaderStateDetail {
  activeTopicId: string | null;
  nodeId: string;
  topics: readonly IssueManagerTopic[];
  workspaceId: string;
}

interface IssueManagerTopicSelectionDetail {
  nodeId: string;
  topicId: string;
  workspaceId: string;
}

interface IssueManagerTopicCreateDetail {
  input: IssueManagerTopicCreateEventInput;
  nodeId: string;
  workspaceId: string;
}

interface IssueManagerTopicDeleteDetail {
  nodeId: string;
  topicId: string;
  workspaceId: string;
}

interface IssueManagerTopicUpdateDetail {
  input: IssueManagerTopicUpdateEventInput;
  nodeId: string;
  workspaceId: string;
}

interface IssueManagerIssueCreateRequestDetail {
  nodeId: string;
  workspaceId: string;
}

type IssueManagerEventHubListener<TDetail> = (detail: TDetail) => void;

function createIssueManagerKeyedEventHub<TDetail>(input: {
  getKey: (detail: TDetail) => string;
}) {
  const listenerSetByKey = new Map<
    string,
    Set<IssueManagerEventHubListener<TDetail>>
  >();

  return {
    publish(detail: TDetail): void {
      listenerSetByKey.get(input.getKey(detail))?.forEach((listener) => {
        listener(detail);
      });
    },
    subscribe(
      key: string,
      listener: IssueManagerEventHubListener<TDetail>
    ): () => void {
      let listenerSet = listenerSetByKey.get(key);
      if (!listenerSet) {
        listenerSet = new Set();
        listenerSetByKey.set(key, listenerSet);
      }
      listenerSet.add(listener);

      return () => {
        listenerSet?.delete(listener);
        if (listenerSet?.size === 0) {
          listenerSetByKey.delete(key);
        }
      };
    }
  };
}

function createIssueManagerKeyedReplayEventHub<TDetail>(input: {
  getKey: (detail: TDetail) => string;
}) {
  const currentByKey = new Map<string, TDetail>();
  const eventHub = createIssueManagerKeyedEventHub<TDetail>(input);

  return {
    get(key: string): TDetail | null {
      return currentByKey.get(key) ?? null;
    },
    publish(detail: TDetail): void {
      currentByKey.set(input.getKey(detail), detail);
      eventHub.publish(detail);
    },
    subscribe(
      key: string,
      listener: IssueManagerEventHubListener<TDetail>
    ): () => void {
      const unsubscribe = eventHub.subscribe(key, listener);
      const current = currentByKey.get(key);
      if (current) {
        listener(current);
      }
      return unsubscribe;
    }
  };
}

const issueManagerTopicHeaderStateHub =
  createIssueManagerKeyedReplayEventHub<IssueManagerTopicHeaderStateDetail>({
    getKey: issueManagerNodeScopeKey
  });
const issueManagerTopicSelectionHub =
  createIssueManagerKeyedEventHub<IssueManagerTopicSelectionDetail>({
    getKey: issueManagerNodeScopeKey
  });
const issueManagerTopicCreateHub =
  createIssueManagerKeyedEventHub<IssueManagerTopicCreateDetail>({
    getKey: issueManagerNodeScopeKey
  });
const issueManagerTopicDeleteHub =
  createIssueManagerKeyedEventHub<IssueManagerTopicDeleteDetail>({
    getKey: issueManagerNodeScopeKey
  });
const issueManagerTopicUpdateHub =
  createIssueManagerKeyedEventHub<IssueManagerTopicUpdateDetail>({
    getKey: issueManagerNodeScopeKey
  });
const issueManagerIssueCreateRequestHub =
  createIssueManagerKeyedEventHub<IssueManagerIssueCreateRequestDetail>({
    getKey: issueManagerNodeScopeKey
  });

export function resolveIssueManagerTopicHeaderState(input: {
  activeTopicId: string | null;
  nodeId: string;
  workspaceId: string;
}): IssueManagerTopicHeaderStateDetail {
  return (
    issueManagerTopicHeaderStateHub.get(issueManagerNodeScopeKey(input)) ?? {
      activeTopicId: input.activeTopicId,
      nodeId: input.nodeId,
      topics: [],
      workspaceId: input.workspaceId
    }
  );
}

export function dispatchIssueManagerTaskListCollapsed(input: {
  collapsed: boolean;
  nodeId: string;
  workspaceId: string;
}): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<IssueManagerTaskListCollapsedDetail>(
      issueManagerTaskListCollapsedEvent,
      {
        detail: input
      }
    )
  );
}

export function dispatchIssueManagerTopicHeaderState(
  input: IssueManagerTopicHeaderStateDetail
): void {
  issueManagerTopicHeaderStateHub.publish(input);
}

export function dispatchIssueManagerTopicSelection(
  input: IssueManagerTopicSelectionDetail
): void {
  issueManagerTopicSelectionHub.publish(input);
}

export function dispatchIssueManagerTopicCreate(
  input: IssueManagerTopicCreateDetail
): void {
  issueManagerTopicCreateHub.publish(input);
}

export function dispatchIssueManagerTopicDelete(
  input: IssueManagerTopicDeleteDetail
): void {
  issueManagerTopicDeleteHub.publish(input);
}

export function dispatchIssueManagerTopicUpdate(
  input: IssueManagerTopicUpdateDetail
): void {
  issueManagerTopicUpdateHub.publish(input);
}

export function dispatchIssueManagerIssueCreateRequest(
  input: IssueManagerIssueCreateRequestDetail
): void {
  issueManagerIssueCreateRequestHub.publish(input);
}

export function useIssueManagerTaskListCollapsedSync(input: {
  nodeId: string;
  onCollapsedChange: (collapsed: boolean) => void;
  workspaceId: string;
}): void {
  const onCollapsedChange = useEffectEvent(input.onCollapsedChange);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleTaskListCollapsedChange = (event: Event) => {
      const detail = (event as CustomEvent<IssueManagerTaskListCollapsedDetail>)
        .detail;
      if (
        detail?.nodeId !== input.nodeId ||
        detail.workspaceId !== input.workspaceId
      ) {
        return;
      }
      onCollapsedChange(detail.collapsed);
    };

    window.addEventListener(
      issueManagerTaskListCollapsedEvent,
      handleTaskListCollapsedChange
    );
    return () => {
      window.removeEventListener(
        issueManagerTaskListCollapsedEvent,
        handleTaskListCollapsedChange
      );
    };
  }, [input.nodeId, input.workspaceId, onCollapsedChange]);
}

export function useIssueManagerTopicHeaderStateSync(input: {
  activeTopicId: string | null;
  nodeId: string;
  workspaceId: string;
}) {
  const [state, setState] = useState<IssueManagerTopicHeaderStateDetail>(() =>
    resolveIssueManagerTopicHeaderState(input)
  );

  useEffect(() => {
    setState((current) =>
      current.activeTopicId === input.activeTopicId &&
      current.nodeId === input.nodeId &&
      current.workspaceId === input.workspaceId &&
      current.topics === resolveIssueManagerTopicHeaderState(input).topics
        ? current
        : resolveIssueManagerTopicHeaderState(input)
    );
  }, [input.activeTopicId, input.nodeId, input.workspaceId]);

  useEffect(() => {
    const handleTopicHeaderStateChange = (
      detail: IssueManagerTopicHeaderStateDetail
    ) => {
      setState(detail);
    };

    return issueManagerTopicHeaderStateHub.subscribe(
      issueManagerNodeScopeKey(input),
      handleTopicHeaderStateChange
    );
  }, [input.nodeId, input.workspaceId]);

  return state;
}

export function useIssueManagerTopicHeaderCommandSync(input: {
  nodeId: string;
  onCreateTopic: (topicInput: IssueManagerTopicCreateEventInput) => void;
  onDeleteTopic: (topicId: string) => void;
  onSelectTopic: (topicId: string) => void;
  onUpdateTopic: (topicInput: IssueManagerTopicUpdateEventInput) => void;
  workspaceId: string;
}): void {
  const onCreateTopic = useEffectEvent(input.onCreateTopic);
  const onDeleteTopic = useEffectEvent(input.onDeleteTopic);
  const onSelectTopic = useEffectEvent(input.onSelectTopic);
  const onUpdateTopic = useEffectEvent(input.onUpdateTopic);

  useEffect(() => {
    const handleTopicSelection = (detail: IssueManagerTopicSelectionDetail) => {
      onSelectTopic(detail.topicId);
    };
    const handleTopicCreate = (detail: IssueManagerTopicCreateDetail) => {
      onCreateTopic(detail.input);
    };
    const handleTopicDelete = (detail: IssueManagerTopicDeleteDetail) => {
      onDeleteTopic(detail.topicId);
    };
    const handleTopicUpdate = (detail: IssueManagerTopicUpdateDetail) => {
      onUpdateTopic(detail.input);
    };

    const unsubscribeSelection = issueManagerTopicSelectionHub.subscribe(
      issueManagerNodeScopeKey(input),
      handleTopicSelection
    );
    const unsubscribeCreate = issueManagerTopicCreateHub.subscribe(
      issueManagerNodeScopeKey(input),
      handleTopicCreate
    );
    const unsubscribeDelete = issueManagerTopicDeleteHub.subscribe(
      issueManagerNodeScopeKey(input),
      handleTopicDelete
    );
    const unsubscribeUpdate = issueManagerTopicUpdateHub.subscribe(
      issueManagerNodeScopeKey(input),
      handleTopicUpdate
    );
    return () => {
      unsubscribeSelection();
      unsubscribeCreate();
      unsubscribeDelete();
      unsubscribeUpdate();
    };
  }, [
    input.nodeId,
    input.workspaceId,
    onCreateTopic,
    onDeleteTopic,
    onSelectTopic,
    onUpdateTopic
  ]);
}

export function useIssueManagerIssueCreateRequestSync(input: {
  nodeId: string;
  onCreateIssue: () => void;
  workspaceId: string;
}): void {
  const onCreateIssue = useEffectEvent(input.onCreateIssue);

  useEffect(() => {
    const handleCreateIssueRequest = () => {
      onCreateIssue();
    };

    return issueManagerIssueCreateRequestHub.subscribe(
      issueManagerNodeScopeKey(input),
      handleCreateIssueRequest
    );
  }, [input.nodeId, input.workspaceId, onCreateIssue]);
}

export function useIssueManagerNodeHeaderView(input: {
  copy: IssueManagerI18nRuntime;
  isSidebarAutoCollapsed: boolean;
  isSidebarCollapsed: boolean;
  nodeId: string;
  onToggleSidebar: (nextCollapsed: boolean) => void;
  workspaceId: string;
}) {
  const [manualCollapsed, setManualCollapsed] = useState(
    input.isSidebarCollapsed
  );

  useEffect(() => {
    setManualCollapsed(input.isSidebarCollapsed);
  }, [input.isSidebarCollapsed]);

  useIssueManagerTaskListCollapsedSync({
    nodeId: input.nodeId,
    onCollapsedChange: setManualCollapsed,
    workspaceId: input.workspaceId
  });

  const effectiveCollapsed = input.isSidebarAutoCollapsed || manualCollapsed;

  return {
    effectiveCollapsed,
    toggleLabel: effectiveCollapsed
      ? input.copy.t("actions.expandIssueList")
      : input.copy.t("actions.collapseIssueList"),
    toggleSidebar: () => {
      input.onToggleSidebar(!effectiveCollapsed);
    }
  };
}

function issueManagerNodeScopeKey(input: {
  nodeId: string;
  workspaceId: string;
}): string {
  return `${input.workspaceId}\0${input.nodeId}`;
}

export function resolveIssueManagerSelectedIssue(input: {
  issueDetail: IssueManagerIssueSummary | null;
  issues: readonly IssueManagerIssueSummary[];
  selectedIssueId: string | null;
}): IssueManagerIssueSummary | null {
  if (!input.selectedIssueId) {
    return null;
  }

  return (
    input.issueDetail ??
    input.issues.find((issue) => issue.issueId === input.selectedIssueId) ??
    null
  );
}

export function resolveIssueManagerSelectedTask(input: {
  selectedTaskId: string | null;
  taskDetail: IssueManagerTaskSummary | null;
  tasks: readonly IssueManagerTaskSummary[];
}): IssueManagerTaskSummary | null {
  if (!input.selectedTaskId) {
    return null;
  }

  return (
    input.taskDetail ??
    input.tasks.find((task) => task.taskId === input.selectedTaskId) ??
    null
  );
}
