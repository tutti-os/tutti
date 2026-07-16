import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type {
  IssueManagerAnalyticsEvent,
  IssueManagerIssueDetail,
  IssueManagerIssueSummary,
  IssueManagerTaskDetail,
  IssueManagerTaskSummary,
  IssueManagerTopic
} from "../../contracts/index.ts";
import type { IssueManagerFeature } from "../../core/index.ts";
import { createIssueManagerControllerRuntime } from "./controllerRuntime.ts";

test("controllerRuntime loads issue detail without defaulting to a task selection", async () => {
  const issueDetailCalls: string[] = [];
  const taskDetailCalls: string[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      async getIssueDetail(input) {
        issueDetailCalls.push(input.issueId);
        return createIssueDetail({
          issue: createIssueSummary({
            issueId: input.issueId,
            title: "Plan migration"
          }),
          tasks: [
            createTaskSummary({
              issueId: input.issueId,
              taskId: "task-1",
              title: "Port renderer"
            })
          ]
        });
      },
      async getTaskDetail(input) {
        taskDetailCalls.push(`${input.issueId}:${input.taskId}`);
        return createTaskDetail({
          task: createTaskSummary({
            issueId: input.issueId,
            taskId: input.taskId,
            title: "Port renderer"
          })
        });
      },
      async listIssues() {
        return {
          issues: [
            createIssueSummary({
              issueId: "issue-1",
              title: "Plan migration"
            })
          ]
        };
      }
    }),
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();

  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.nodeState.selectedIssueId, "issue-1");
  assert.equal(snapshot.nodeState.selectedTaskId, null);
  assert.equal(runtime.store.nodeState.selectedIssueId, "issue-1");
  assert.equal(runtime.store.nodeState.selectedTaskId, null);
  assert.deepEqual(issueDetailCalls, ["issue-1"]);
  assert.deepEqual(taskDetailCalls, []);
  assert.equal(snapshot.issueDraft.title, "Plan migration");
  assert.equal(snapshot.taskDraft.title, "");

  runtime.release();
});

test("controllerRuntime reports issue-manager opened once per session", async () => {
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      analytics: {
        track(event) {
          analyticsEvents.push(event);
        }
      }
    }),
    workspaceId: "workspace-1"
  });

  runtime.retain();
  runtime.retain();
  runtime.release();
  runtime.retain();
  await flushAsyncWork();

  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.opened",
      params: {
        source: "restore",
        trigger: "automatic"
      }
    }
  ]);

  runtime.release();
});

test("controllerRuntime reports issue-manager opened trigger from input", async () => {
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      analytics: {
        track(event) {
          analyticsEvents.push(event);
        }
      }
    }),
    openSource: "agent_command",
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();

  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.opened",
      params: {
        source: "agent_command",
        trigger: "automatic"
      }
    }
  ]);

  runtime.release();
});

test("controllerRuntime reloads issues when deferred search input changes", async () => {
  const searches: string[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      analytics: {
        track(event) {
          analyticsEvents.push(event);
        }
      },
      backend: {
        async listIssues(input) {
          searches.push(input.searchQuery ?? "");
          return {
            issues: input.searchQuery
              ? [
                  createIssueSummary({
                    issueId: "issue-2",
                    title: "Migration"
                  })
                ]
              : []
          };
        }
      }
    }),
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();
  analyticsEvents.length = 0;

  runtime.syncInput({
    deferredIssueSearch: "migration",
    onStateChange: undefined,
    taskListCollapsed: false
  });
  await flushAsyncWork();

  assert.deepEqual(searches, ["", "migration"]);
  assert.deepEqual(analyticsEvents, []);

  runtime.reportIssueSearchUsage("migration");

  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_searched",
      params: {
        queryLength: 9,
        resultCount: 1
      }
    }
  ]);

  runtime.release();
});

test("controllerRuntime loads running issues with a single running filter", async () => {
  const statusFilters: string[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      async listIssues(input) {
        statusFilters.push(input.statusFilter ?? "");
        if (input.statusFilter === "running") {
          return {
            issues: [
              {
                ...createIssueSummary({
                  issueId: "issue-running",
                  title: "Running task"
                }),
                status: "running"
              }
            ]
          };
        }
        return {
          issues: []
        };
      }
    }),
    state: {
      activeTopicId: "topic-1",
      issueStatusFilter: "running"
    },
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.deepEqual(statusFilters, ["running"]);
  assert.deepEqual(
    runtime
      .getSnapshot()
      .issues.value.map((issue) => [issue.issueId, issue.status]),
    [["issue-running", "running"]]
  );

  runtime.release();
});

test("controllerRuntime clears stale issues immediately when topic changes", async () => {
  const topicTwoIssues = createDeferred<{
    issues: IssueManagerIssueSummary[];
  }>();
  const issueTopicCalls: string[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      async listIssues(input) {
        issueTopicCalls.push(input.topicId ?? "");
        if (input.topicId === "topic-2") {
          return topicTwoIssues.promise;
        }
        return {
          issues: [
            createIssueSummary({
              issueId: "issue-topic-1",
              title: "Topic 1 issue",
              topicId: "topic-1"
            })
          ]
        };
      }
    }),
    state: {
      activeTopicId: "topic-1"
    },
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();

  assert.deepEqual(issueTopicCalls, ["topic-1"]);
  assert.deepEqual(
    runtime.getSnapshot().issues.value.map((issue) => issue.issueId),
    ["issue-topic-1"]
  );

  runtime.updateNodeState({
    activeTopicId: "topic-2"
  });

  assert.deepEqual(issueTopicCalls, ["topic-1", "topic-2"]);
  assert.equal(runtime.getSnapshot().issues.isLoading, true);
  assert.deepEqual(runtime.getSnapshot().issues.value, []);

  topicTwoIssues.resolve({
    issues: [
      createIssueSummary({
        issueId: "issue-topic-2",
        title: "Topic 2 issue",
        topicId: "topic-2"
      })
    ]
  });
  await flushAsyncWork();

  assert.deepEqual(
    runtime.getSnapshot().issues.value.map((issue) => issue.issueId),
    ["issue-topic-2"]
  );

  runtime.release();
});

test("controllerRuntime reports task search analytics only for explicit search usage", async () => {
  const searches: string[] = [];
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      analytics: {
        track(event) {
          analyticsEvents.push(event);
        }
      },
      backend: {
        async listIssues(input) {
          searches.push(
            `${input.topicId}:${input.searchQuery ?? ""}:${input.statusFilter ?? ""}`
          );
          return {
            issues: []
          };
        },
        async listTopics() {
          return {
            topics: [
              createTopic(),
              createTopic({
                isDefault: false,
                title: "Secondary",
                topicId: "topic-2"
              })
            ]
          };
        }
      }
    }),
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();
  analyticsEvents.length = 0;

  runtime.syncInput({
    deferredIssueSearch: "migration",
    onStateChange: undefined,
    taskListCollapsed: false
  });
  await flushAsyncWork();

  assert.deepEqual(analyticsEvents, []);

  runtime.reportIssueSearchUsage("migration");

  runtime.updateNodeState({
    activeTopicId: "topic-2"
  });
  await flushAsyncWork();

  assert.deepEqual(searches, [
    "topic-1::all",
    "topic-1:migration:all",
    "topic-2:migration:all"
  ]);
  assert.deepEqual(analyticsEvents, [
    {
      name: "issue_manager.task_searched",
      params: {
        queryLength: 9,
        resultCount: 0
      }
    }
  ]);

  runtime.release();
});

test("controllerRuntime skips task search analytics for blank search usage", async () => {
  const analyticsEvents: IssueManagerAnalyticsEvent[] = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      analytics: {
        track(event) {
          analyticsEvents.push(event);
        }
      }
    }),
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();
  analyticsEvents.length = 0;

  runtime.reportIssueSearchUsage("   ");

  assert.deepEqual(analyticsEvents, []);

  runtime.release();
});

test("controllerRuntime preserves drafts in edit mode and resyncs in read mode", async () => {
  let currentTitle = "Plan migration";
  let currentContent = "Initial body";
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      async getIssueDetail(input) {
        return createIssueDetail({
          issue: createIssueSummary({
            content: currentContent,
            issueId: input.issueId,
            title: currentTitle
          }),
          tasks: []
        });
      },
      async listIssues() {
        return {
          issues: [
            createIssueSummary({
              issueId: "issue-1",
              title: currentTitle
            })
          ]
        };
      }
    }),
    state: {
      selectedIssueId: "issue-1"
    },
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();

  assert.equal(runtime.getSnapshot().issueDraft.title, "Plan migration");

  runtime.setIssueEditorModeState("edit");
  runtime.setIssueDraftInternal({
    content: "Unsaved body",
    title: "Working copy"
  });

  currentTitle = "Updated on server";
  currentContent = "Updated body";
  runtime.refreshDetails();
  await flushAsyncWork();

  assert.deepEqual(runtime.getSnapshot().issueDraft, {
    content: "Unsaved body",
    title: "Working copy"
  });

  runtime.setIssueEditorModeState("read");
  assert.deepEqual(runtime.getSnapshot().issueDraft, {
    content: "Updated body",
    dispatchPaused: false,
    title: "Updated on server"
  });

  runtime.release();
});

test("controllerRuntime refreshes retained data on issue update events", async () => {
  let issueListCalls = 0;
  let issueDetailCalls = 0;
  let taskDetailCalls = 0;
  const issueUpdateListeners: Array<
    Parameters<
      NonNullable<IssueManagerFeature["eventSource"]>["subscribeToIssueUpdates"]
    >[1]
  > = [];
  const runtime = createIssueManagerControllerRuntime({
    feature: createFeature({
      backend: {
        async getIssueDetail(input) {
          issueDetailCalls += 1;
          return createIssueDetail({
            issue: createIssueSummary({
              issueId: input.issueId,
              title: "Issue"
            }),
            tasks: [
              createTaskSummary({
                issueId: input.issueId,
                taskId: "task-1",
                title: "Task"
              })
            ]
          });
        },
        async getTaskDetail(input) {
          taskDetailCalls += 1;
          return createTaskDetail({
            task: createTaskSummary({
              issueId: input.issueId,
              taskId: input.taskId,
              title: "Task"
            })
          });
        },
        async listIssues() {
          issueListCalls += 1;
          return {
            issues: [
              createIssueSummary({
                issueId: "issue-1",
                title: "Issue"
              })
            ]
          };
        }
      },
      eventSource: {
        subscribeToIssueUpdates(_workspaceId, listener) {
          issueUpdateListeners.push(listener);
          return () => {
            issueUpdateListeners.length = 0;
          };
        }
      }
    }),
    state: {
      activeTopicId: "topic-1",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1"
    },
    workspaceId: "workspace-1"
  });

  runtime.retain();
  await flushAsyncWork();

  assert.equal(issueListCalls, 1);
  assert.equal(issueDetailCalls, 1);
  assert.equal(taskDetailCalls, 1);

  assert.equal(issueUpdateListeners.length, 1);
  issueUpdateListeners[0]?.({
    changeKind: "task_updated",
    issueId: "issue-1",
    taskId: "task-1",
    workspaceId: "workspace-1"
  });
  await flushAsyncWork();

  assert.equal(issueListCalls, 2);
  assert.equal(issueDetailCalls, 2);
  assert.equal(taskDetailCalls, 2);

  runtime.release();
  assert.equal(issueUpdateListeners.length, 0);
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createFeature(
  input?:
    | Partial<IssueManagerFeature["backend"]>
    | {
        analytics?: IssueManagerFeature["analytics"];
        backend?: Partial<IssueManagerFeature["backend"]>;
        eventSource?: IssueManagerFeature["eventSource"];
      }
): IssueManagerFeature {
  const backendOverrides = input && "backend" in input ? input.backend : input;
  const analytics = input && "analytics" in input ? input.analytics : undefined;
  const eventSource =
    input && "eventSource" in input ? input.eventSource : undefined;
  return {
    agentRunner: {
      async runTask() {
        return {
          status: "completed" as const
        };
      }
    },
    analytics,
    backend: {
      async addContextRefs() {
        return [];
      },
      async completeRun() {
        throw new Error("not implemented");
      },
      async createIssue() {
        throw new Error("not implemented");
      },
      async createTopic() {
        return createTopic();
      },
      async createRun() {
        throw new Error("not implemented");
      },
      async createTask() {
        throw new Error("not implemented");
      },
      async deleteIssue() {
        return { removed: true };
      },
      async deleteTask() {
        return { removed: true };
      },
      async deleteTopic() {
        return { removed: true };
      },
      async getIssueDetail(input) {
        return createIssueDetail({
          issue: createIssueSummary({
            issueId: input.issueId,
            title: "Issue"
          }),
          tasks: []
        });
      },
      async getTaskDetail(input) {
        return createTaskDetail({
          task: createTaskSummary({
            issueId: input.issueId,
            taskId: input.taskId,
            title: "Task"
          })
        });
      },
      async listIssues() {
        return { issues: [] };
      },
      async listTasks() {
        return { tasks: [] };
      },
      async listTopics() {
        return { topics: [createTopic()] };
      },
      async removeContextRef() {
        return { removed: true };
      },
      async updateIssue() {
        throw new Error("not implemented");
      },
      async updateTask() {
        throw new Error("not implemented");
      },
      async updateTopic() {
        return createTopic();
      },
      ...backendOverrides
    },
    eventSource,
    i18n: {
      t(key: string) {
        return key;
      }
    } as IssueManagerFeature["i18n"],
    identityAdapter: {
      currentUser() {
        return {
          displayName: "Local",
          userId: "local"
        };
      }
    },
    workspaceUserProjectI18n: createDefaultWorkspaceUserProjectI18nRuntime(),
    ui: {
      showInviteCollaborator: true
    }
  };
}

function createIssueSummary(
  input: Partial<IssueManagerIssueSummary> & {
    issueId: string;
    title: string;
  }
): IssueManagerIssueSummary {
  return {
    creatorUserId: "local",
    ...input,
    issueId: input.issueId,
    status: "not_started",
    title: input.title,
    topicId: input.topicId ?? "topic-1",
    workspaceId: input.workspaceId ?? "workspace-1"
  };
}

function createTopic(
  input: Partial<IssueManagerTopic> = {}
): IssueManagerTopic {
  return {
    createdAtUnix: 1,
    isDefault: input.isDefault ?? true,
    lastActivityAtUnix: 1,
    pinnedAtUnix: 0,
    summary: "",
    title: input.title ?? "Default",
    topicId: input.topicId ?? "topic-1",
    updatedAtUnix: 1,
    workspaceId: input.workspaceId ?? "workspace-1"
  };
}

function createTaskSummary(
  input: Partial<IssueManagerTaskSummary> & {
    issueId: string;
    taskId: string;
    title: string;
  }
): IssueManagerTaskSummary {
  return {
    creatorUserId: "local",
    ...input,
    issueId: input.issueId,
    priority: "medium",
    status: "not_started",
    taskId: input.taskId,
    title: input.title,
    workspaceId: input.workspaceId ?? "workspace-1"
  };
}

function createIssueDetail(
  input: Partial<IssueManagerIssueDetail> & {
    issue: IssueManagerIssueSummary;
    tasks: IssueManagerTaskSummary[];
  }
): IssueManagerIssueDetail {
  return {
    contextRefs: [],
    latestOutputs: [],
    recentRuns: [],
    ...input
  };
}

function createTaskDetail(
  input: Partial<IssueManagerTaskDetail> & {
    task: IssueManagerTaskSummary;
  }
): IssueManagerTaskDetail {
  return {
    contextRefs: [],
    latestOutputs: [],
    recentRuns: [],
    ...input
  };
}
