import type { SetStateAction } from "react";
import type {
  IssueManagerContextRef,
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerAnalyticsAdapter,
  IssueManagerNodeState,
  IssueManagerRun,
  IssueManagerTaskDetail,
  IssueManagerTaskSummary
} from "../../contracts/index.ts";
import type { IssueManagerFeature } from "../../core/index.ts";
import { createIssueManagerControllerActions } from "./controllerActions.ts";
import type { IssueDraft, TaskDraft } from "./controllerTypes.ts";
import type { IssueManagerI18nRuntime } from "../../i18n/issueManagerI18n.ts";
import type {
  IssueManagerEditorMode,
  IssueManagerReferenceTarget
} from "./model.ts";

export function createControllerActionsHarness(input?: {
  agentBreakdownLauncher?: Partial<
    NonNullable<IssueManagerFeature["agentBreakdownLauncher"]>
  >;
  agentSessionOpener?: Partial<
    NonNullable<IssueManagerFeature["agentSessionOpener"]>
  >;
  analytics?: IssueManagerAnalyticsAdapter;
  agentRunner?: Partial<IssueManagerFeature["agentRunner"]>;
  backend?: Partial<IssueManagerFeature["backend"]>;
  executionDirectoryPicker?: Partial<
    NonNullable<IssueManagerFeature["executionDirectoryPicker"]>
  >;
  fileAdapter?: Partial<NonNullable<IssueManagerFeature["fileAdapter"]>>;
  issueDetail?: IssueManagerIssueDetail | null;
  issueDraft?: IssueDraft;
  issueEditorMode?: IssueManagerEditorMode;
  nodeState?: IssueManagerNodeState;
  referenceTarget?: IssueManagerReferenceTarget | null;
  shareAdapter?: Partial<NonNullable<IssueManagerFeature["shareAdapter"]>>;
  taskDetail?: IssueManagerTaskDetail | null;
  taskDraft?: TaskDraft;
  taskEditorMode?: IssueManagerEditorMode;
}) {
  const issueDraftState = createStateBox<IssueDraft>(
    input?.issueDraft ?? {
      content: "",
      title: ""
    }
  );
  const taskDraftState = createStateBox<TaskDraft>(
    input?.taskDraft ?? {
      content: "",
      priority: "medium",
      title: ""
    }
  );
  const issueEditorModeState = createStateBox<IssueManagerEditorMode>(
    input?.issueEditorMode ?? "read"
  );
  const taskEditorModeState = createStateBox<IssueManagerEditorMode>(
    input?.taskEditorMode ?? "read"
  );
  const notificationState = createNotificationBox();
  const referenceTargetState =
    createStateBox<IssueManagerReferenceTarget | null>(
      input?.referenceTarget ?? null
    );
  const isRunningTaskState = createStateBox(false);
  let refreshAllCount = 0;
  let refreshDetailsCount = 0;
  const nodeStateBox = createNodeStateBox(
    input?.nodeState ?? {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: null,
      selectedTaskId: null
    }
  );
  const copy = {
    t(key: string) {
      return key;
    }
  } as IssueManagerI18nRuntime;

  const feature = {
    agentBreakdownLauncher: input?.agentBreakdownLauncher
      ? {
          startBreakdown() {
            return resolved({
              status: "opened" as const
            });
          },
          ...input.agentBreakdownLauncher
        }
      : undefined,
    analytics: input?.analytics,
    agentRunner: {
      runTask() {
        return resolved({
          status: "completed" as const
        });
      },
      ...input?.agentRunner
    },
    agentSessionOpener: input?.agentSessionOpener
      ? {
          openSession() {},
          ...input.agentSessionOpener
        }
      : undefined,
    backend: {
      addContextRefs() {
        return resolved([]);
      },
      completeRun() {
        return resolved({
          outputs: [],
          run: createRun({
            issueId: "issue-1",
            runId: "run-1",
            status: "completed",
            taskId: "task-1"
          })
        });
      },
      createIssue() {
        return resolved(
          createIssueSummary({
            issueId: "issue-1",
            title: "Issue"
          })
        );
      },
      createTopic() {
        return resolved(createTopic());
      },
      createRun() {
        return resolved(
          createRun({
            issueId: "issue-1",
            runId: "run-1",
            status: "running",
            taskId: "task-1"
          })
        );
      },
      createTask() {
        return resolved(
          createTaskSummary({
            issueId: "issue-1",
            taskId: "task-1",
            title: "Task"
          })
        );
      },
      deleteIssue() {
        return resolved({ removed: true });
      },
      deleteTask() {
        return resolved({ removed: true });
      },
      deleteTopic() {
        return resolved({ removed: true });
      },
      getIssueDetail() {
        return resolved(createIssueDetail());
      },
      getTaskDetail() {
        return resolved(createTaskDetail());
      },
      listIssues() {
        return resolved({ issues: [] });
      },
      listTasks() {
        return resolved({ tasks: [] });
      },
      listTopics() {
        return resolved({ topics: [createTopic()] });
      },
      removeContextRef() {
        return resolved({ removed: true });
      },
      updateIssue() {
        return resolved(
          createIssueSummary({
            issueId: "issue-1",
            title: "Issue"
          })
        );
      },
      updateTask() {
        return resolved(
          createTaskSummary({
            issueId: "issue-1",
            taskId: "task-1",
            title: "Task"
          })
        );
      },
      updateTopic() {
        return resolved(createTopic());
      },
      ...input?.backend
    },
    executionDirectoryPicker: input?.executionDirectoryPicker
      ? {
          ...input.executionDirectoryPicker
        }
      : undefined,
    fileAdapter: input?.fileAdapter,
    i18n: copy,
    identityAdapter: {
      currentUser() {
        return {
          displayName: "Local",
          userId: "local"
        };
      }
    },
    notifications: {
      tips: (message) => notificationState.push(message)
    },
    shareAdapter: input?.shareAdapter,
    ui: {
      showInviteCollaborator: true
    }
  } as IssueManagerFeature;

  const actions = createIssueManagerControllerActions({
    copy,
    feature,
    issueDetail: {
      value: input?.issueDetail ?? null
    },
    issueDraft: issueDraftState.current,
    issueEditorMode: issueEditorModeState.current,
    nodeState: {
      activeTopicId: "topic-1",
      ...nodeStateBox.current
    },
    referenceTarget: referenceTargetState.current,
    refreshAll() {
      refreshAllCount += 1;
    },
    refreshDetails() {
      refreshDetailsCount += 1;
    },
    setNotification({ title }) {
      notificationState.push(title);
    },
    setIsRunningTask: isRunningTaskState.dispatch,
    setIssueDraftInternal: issueDraftState.dispatch,
    setIssueEditorModeState: issueEditorModeState.dispatch,
    setReferenceTarget: referenceTargetState.dispatch,
    setTaskDraftInternal: taskDraftState.dispatch,
    setTaskEditorModeState: taskEditorModeState.dispatch,
    taskDetail: {
      value: input?.taskDetail ?? null
    },
    taskDraft: taskDraftState.current,
    taskEditorMode: taskEditorModeState.current,
    updateNodeState: nodeStateBox.update,
    workspaceId: "workspace-1"
  });

  return {
    actions,
    get refreshAllCount() {
      return refreshAllCount;
    },
    get refreshDetailsCount() {
      return refreshDetailsCount;
    },
    isRunningTaskState,
    issueDraftState,
    issueEditorModeState,
    nodeState: nodeStateBox,
    notificationState,
    referenceTargetState,
    taskDraftState,
    taskEditorModeState
  };
}

function resolved<TValue>(value: TValue): Promise<TValue> {
  return Promise.resolve(value);
}

function createStateBox<TValue>(initialValue: TValue) {
  let current = initialValue;
  const history: TValue[] = [];

  return {
    get current() {
      return current;
    },
    dispatch: (update: SetStateAction<TValue>) => {
      current =
        typeof update === "function"
          ? (update as (value: TValue) => TValue)(current)
          : update;
      history.push(current);
    },
    history
  };
}

function createNotificationBox() {
  const history: string[] = [];

  return {
    get current() {
      return history.at(-1) ?? null;
    },
    history,
    push(message: string) {
      history.push(message);
    }
  };
}

function createNodeStateBox(initialValue: IssueManagerNodeState) {
  let current = initialValue;
  const history: IssueManagerNodeState[] = [];

  return {
    get current() {
      return current;
    },
    update: (
      updater:
        | Partial<IssueManagerNodeState>
        | ((current: IssueManagerNodeState) => IssueManagerNodeState)
    ) => {
      current =
        typeof updater === "function"
          ? updater(current)
          : {
              ...current,
              ...updater
            };
      history.push(current);
    },
    history
  };
}

export function createIssueSummary(
  overrides: Partial<IssueManagerIssueSummary> &
    Pick<IssueManagerIssueSummary, "issueId" | "title">
): IssueManagerIssueSummary {
  return {
    creatorUserId: "local",
    status: overrides.status ?? "not_started",
    topicId: overrides.topicId ?? "topic-1",
    workspaceId: overrides.workspaceId ?? "workspace-1",
    ...overrides
  };
}

function createTopic() {
  return {
    createdAtUnix: 1,
    isDefault: true,
    lastActivityAtUnix: 1,
    pinnedAtUnix: 0,
    summary: "",
    title: "Default",
    topicId: "topic-1",
    updatedAtUnix: 1,
    workspaceId: "workspace-1"
  };
}

export function createTaskSummary(
  overrides: Partial<IssueManagerTaskSummary> &
    Pick<IssueManagerTaskSummary, "issueId" | "taskId" | "title">
): IssueManagerTaskSummary {
  return {
    creatorUserId: "local",
    priority: overrides.priority ?? "medium",
    status: overrides.status ?? "not_started",
    workspaceId: overrides.workspaceId ?? "workspace-1",
    ...overrides
  };
}

export function createRun(input: {
  agentProvider?: string;
  agentSessionId?: string;
  agentTargetId?: string;
  agentUserId?: string;
  completedAtUnix?: number;
  createdAtUnix?: number;
  errorMessage?: string;
  executionDirectory?: string;
  issueId: string;
  outputDir?: string;
  requesterUserId?: string;
  runId: string;
  status: "canceled" | "completed" | "failed" | "running";
  startedAtUnix?: number;
  summary?: string;
  taskId?: string;
  updatedAtUnix?: number;
  workspaceId?: string;
}): IssueManagerRun {
  const run: IssueManagerRun = {
    agentProvider: input.agentProvider ?? "codex",
    agentTargetId: input.agentTargetId ?? "local:codex",
    agentUserId: input.agentUserId ?? "local",
    issueId: input.issueId,
    requesterUserId: input.requesterUserId ?? "local",
    runId: input.runId,
    status: input.status,
    workspaceId: input.workspaceId ?? "workspace-1"
  };

  if (input.agentSessionId !== undefined) {
    run.agentSessionId = input.agentSessionId;
  }
  if (input.completedAtUnix !== undefined) {
    run.completedAtUnix = input.completedAtUnix;
  }
  if (input.createdAtUnix !== undefined) {
    run.createdAtUnix = input.createdAtUnix;
  }
  if (input.errorMessage !== undefined) {
    run.errorMessage = input.errorMessage;
  }
  if (input.executionDirectory !== undefined) {
    run.executionDirectory = input.executionDirectory;
  }
  if (input.outputDir !== undefined) {
    run.outputDir = input.outputDir;
  }
  if (input.startedAtUnix !== undefined) {
    run.startedAtUnix = input.startedAtUnix;
  }
  if (input.summary !== undefined) {
    run.summary = input.summary;
  }
  if (input.taskId !== undefined) {
    run.taskId = input.taskId;
  }
  if (input.updatedAtUnix !== undefined) {
    run.updatedAtUnix = input.updatedAtUnix;
  }

  return run;
}

export function createIssueDetail(): IssueManagerIssueDetail {
  return {
    contextRefs: [],
    issue: createIssueSummary({
      issueId: "issue-1",
      title: "Issue"
    }),
    latestOutputs: [],
    recentRuns: [],
    tasks: []
  };
}

export function createTaskDetail(): IssueManagerTaskDetail {
  return {
    contextRefs: [],
    latestOutputs: [],
    recentRuns: [],
    task: createTaskSummary({
      issueId: "issue-1",
      taskId: "task-1",
      title: "Task"
    })
  };
}

export function createTaskContextRef(input: {
  path: string;
  taskId: string;
}): IssueManagerContextRef {
  return {
    contextRefId: `${input.taskId}:${input.path}`,
    displayName: input.path.split("/").filter(Boolean).at(-1) ?? input.path,
    issueId: "issue-1",
    parentKind: "task",
    path: input.path,
    refType: "file",
    taskId: input.taskId,
    workspaceId: "workspace-1"
  };
}

export function createIssueContextRef(input: {
  path: string;
}): IssueManagerContextRef {
  return {
    contextRefId: `issue:${input.path}`,
    displayName: input.path.split("/").filter(Boolean).at(-1) ?? input.path,
    issueId: "issue-1",
    parentKind: "issue",
    path: input.path,
    refType: "file",
    workspaceId: "workspace-1"
  };
}

export function installNavigatorClipboard(
  writeText: (value: string) => Promise<void>
): () => void {
  const originalNavigator = Reflect.get(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText
      }
    },
    writable: true
  });

  return () => {
    if (originalNavigator === undefined) {
      Reflect.deleteProperty(globalThis, "navigator");
      return;
    }
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
      writable: true
    });
  };
}

export function installConfirm(confirm: () => boolean): () => void {
  const originalConfirm = Reflect.get(globalThis, "confirm");
  Object.defineProperty(globalThis, "confirm", {
    configurable: true,
    value: confirm,
    writable: true
  });

  return () => {
    if (originalConfirm === undefined) {
      Reflect.deleteProperty(globalThis, "confirm");
      return;
    }
    Object.defineProperty(globalThis, "confirm", {
      configurable: true,
      value: originalConfirm,
      writable: true
    });
  };
}

export function installNavigatorValue(
  value: Record<string, unknown> | undefined
): () => void {
  const originalNavigator = Reflect.get(globalThis, "navigator");
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, "navigator");
  } else {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value,
      writable: true
    });
  }

  return () => {
    if (originalNavigator === undefined) {
      Reflect.deleteProperty(globalThis, "navigator");
      return;
    }
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
      writable: true
    });
  };
}
