import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { createDesktopIssueManagerBackend } from "./desktopIssueManagerBackend.ts";

test("desktop issue-manager backend routes issue and task context refs", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend = createDesktopIssueManagerBackend(
    createTuttidClient({
      async addWorkspaceIssueContextRefs(...args) {
        calls.push({ args, method: "addIssueRefs" });
        return {
          contextRefs: [{ contextRefId: "issue-ref-1", parentKind: "issue" }]
        } as never;
      },
      async addWorkspaceIssueTaskContextRefs(...args) {
        calls.push({ args, method: "addTaskRefs" });
        return {
          contextRefs: [{ contextRefId: "task-ref-1", parentKind: "task" }]
        } as never;
      },
      async removeWorkspaceIssueContextRef(...args) {
        calls.push({ args, method: "removeIssueRef" });
        return {} as never;
      },
      async removeWorkspaceIssueTaskContextRef(...args) {
        calls.push({ args, method: "removeTaskRef" });
        return {} as never;
      }
    })
  );

  const issueRefs = await backend.addContextRefs({
    issueId: "issue-1",
    parentKind: "issue",
    refs: [
      { displayName: "Spec", path: "/workspace/docs/spec.md", refType: "file" }
    ],
    workspaceId: "workspace-1"
  });
  const taskRefs = await backend.addContextRefs({
    issueId: "issue-1",
    parentKind: "task",
    refs: [
      {
        displayName: "Draft",
        path: "/workspace/docs/draft.md",
        refType: "file"
      }
    ],
    taskId: "task-1",
    workspaceId: "workspace-1"
  });

  await backend.removeContextRef({
    contextRefId: "issue-ref-1",
    issueId: "issue-1",
    parentKind: "issue",
    workspaceId: "workspace-1"
  });
  await backend.removeContextRef({
    contextRefId: "task-ref-1",
    issueId: "issue-1",
    parentKind: "task",
    taskId: "task-1",
    workspaceId: "workspace-1"
  });

  assert.equal(issueRefs[0]?.contextRefId, "issue-ref-1");
  assert.equal(taskRefs[0]?.contextRefId, "task-ref-1");
  assert.deepEqual(calls, [
    {
      args: [
        "workspace-1",
        "issue-1",
        {
          refs: [
            {
              displayName: "Spec",
              path: "/workspace/docs/spec.md",
              refType: "file"
            }
          ]
        }
      ],
      method: "addIssueRefs"
    },
    {
      args: [
        "workspace-1",
        "issue-1",
        "task-1",
        {
          refs: [
            {
              displayName: "Draft",
              path: "/workspace/docs/draft.md",
              refType: "file"
            }
          ]
        }
      ],
      method: "addTaskRefs"
    },
    {
      args: ["workspace-1", "issue-1", "issue-ref-1"],
      method: "removeIssueRef"
    },
    {
      args: ["workspace-1", "issue-1", "task-1", "task-ref-1"],
      method: "removeTaskRef"
    }
  ]);
});

test("desktop issue-manager backend maps list, update, run, and status payloads", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend = createDesktopIssueManagerBackend(
    createTuttidClient({
      async completeWorkspaceIssueTaskRun(...args) {
        calls.push({ args, method: "completeRun" });
        return {} as never;
      },
      async createWorkspaceIssueTaskRun(...args) {
        calls.push({ args, method: "createRun" });
        return { runId: "run-1" } as never;
      },
      async deleteWorkspaceIssueTopic(...args) {
        calls.push({ args, method: "deleteTopic" });
        return { removed: true };
      },
      async listWorkspaceIssues(...args) {
        calls.push({ args, method: "listIssues" });
        return { issues: [], nextPageToken: "next-1" } as never;
      },
      async listWorkspaceIssueTasks(...args) {
        calls.push({ args, method: "listTasks" });
        return { tasks: [] } as never;
      },
      async updateWorkspaceIssueTask(...args) {
        calls.push({ args, method: "updateTask" });
        return { taskId: "task-1" } as never;
      }
    })
  );

  const issueList = await backend.listIssues({
    pageSize: 25,
    pageToken: "page-1",
    searchQuery: "renderer",
    statusFilter: "running",
    topicId: "topic-1",
    workspaceId: "workspace-1"
  });
  await backend.listTasks({
    issueId: "issue-1",
    pageSize: 10,
    pageToken: "page-2",
    searchQuery: "task",
    statusFilter: "all",
    workspaceId: "workspace-1"
  });
  await backend.updateTask({
    content: "content",
    dueAtUnix: 123,
    issueId: "issue-1",
    priority: "urgent",
    sortIndex: 4,
    status: "queued",
    taskId: "task-1",
    title: "Port UI",
    workspaceId: "workspace-1"
  });
  const run = await backend.createRun({
    agentProvider: "codex",
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    agentUserId: "local",
    issueId: "issue-1",
    runId: "run-1",
    taskId: "task-1",
    workspaceId: "workspace-1"
  });
  const deletedTopic = await backend.deleteTopic({
    topicId: "topic-1",
    workspaceId: "workspace-1"
  });
  await backend.completeRun({
    errorMessage: undefined,
    issueId: "issue-1",
    outputs: [{ displayName: "summary.md", path: "/workspace/out/summary.md" }],
    runId: "run-1",
    status: "completed",
    summary: "done",
    taskId: "task-1",
    workspaceId: "workspace-1"
  });

  assert.equal(issueList.nextPageToken, "next-1");
  assert.deepEqual(deletedTopic, { removed: true });
  assert.equal(run.runId, "run-1");
  assert.deepEqual(calls, [
    {
      args: [
        "workspace-1",
        {
          pageSize: 25,
          pageToken: "page-1",
          searchQuery: "renderer",
          statusFilter: "running",
          topicId: "topic-1"
        }
      ],
      method: "listIssues"
    },
    {
      args: [
        "workspace-1",
        "issue-1",
        {
          pageSize: 10,
          pageToken: "page-2",
          searchQuery: "task",
          statusFilter: "all"
        }
      ],
      method: "listTasks"
    },
    {
      args: [
        "workspace-1",
        "issue-1",
        "task-1",
        {
          content: "content",
          dueAtUnix: 123,
          priority: undefined,
          sortIndex: 4,
          status: undefined,
          title: "Port UI"
        }
      ],
      method: "updateTask"
    },
    {
      args: [
        "workspace-1",
        "issue-1",
        "task-1",
        {
          agentProvider: "codex",
          agentSessionId: "session-1",
          agentTargetId: "local:codex",
          agentUserId: "local",
          runId: "run-1"
        }
      ],
      method: "createRun"
    },
    {
      args: ["workspace-1", "topic-1"],
      method: "deleteTopic"
    },
    {
      args: [
        "workspace-1",
        "issue-1",
        "task-1",
        "run-1",
        {
          errorMessage: undefined,
          outputs: [
            {
              displayName: "summary.md",
              path: "/workspace/out/summary.md"
            }
          ],
          status: "completed",
          summary: "done"
        }
      ],
      method: "completeRun"
    }
  ]);
});

test("desktop issue-manager backend rejects run creation without agent target id", async () => {
  const calls: string[] = [];
  const backend = createDesktopIssueManagerBackend(
    createTuttidClient({
      async createWorkspaceIssueTaskRun() {
        calls.push("createRun");
        return { runId: "run-1" } as never;
      }
    })
  );

  await assert.rejects(
    () =>
      backend.createRun({
        agentProvider: "unknown-provider",
        issueId: "issue-1",
        taskId: "task-1",
        workspaceId: "workspace-1"
      }),
    /agentTargetId is required/
  );
  assert.deepEqual(calls, []);
});

function createTuttidClient(overrides: Partial<TuttidClient>): TuttidClient {
  return overrides as TuttidClient;
}
