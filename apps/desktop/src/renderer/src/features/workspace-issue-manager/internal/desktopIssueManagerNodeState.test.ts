import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopIssueManagerNodeStateSource } from "./desktopIssueManagerNodeState.ts";

test("desktop issue-manager node state source keeps whitelisted live node state in memory", (t) => {
  const restore = installFailingLocalStorage();
  t.after(restore);

  const source = createDesktopIssueManagerNodeStateSource({
    workspaceId: "workspace-1"
  });

  source.writeNodeState({
    instanceId: "node-1",
    state: {
      issueDraftContent: "notes",
      issueSearchQuery: "render",
      issueStatusFilter: "running",
      selectedAgentTargetId: "local:codex",
      selectedExecutionDirectory: "/Users/example/project/tutti",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1",
      taskDraftTitle: "Port renderer"
    },
    typeId: "issue-manager"
  });

  assert.deepEqual(
    source.externalStateSource.getNodeState({
      instanceId: "node-1",
      nodeId: "node-1",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    {
      issueSearchQuery: "render",
      issueStatusFilter: "running",
      selectedAgentTargetId: "local:codex",
      selectedExecutionDirectory: "/Users/example/project/tutti",
      selectedIssueId: "issue-1",
      selectedTaskId: "task-1",
      taskListCollapsed: false
    }
  );
  assert.deepEqual(
    source.externalStateSource.getSnapshotNodeState?.({
      instanceId: "node-1",
      nodeId: "node-1",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    {
      issueSearchQuery: "render",
      issueStatusFilter: "running",
      selectedAgentTargetId: "local:codex",
      selectedExecutionDirectory: "/Users/example/project/tutti",
      selectedIssueId: "issue-1",
      taskListCollapsed: false
    }
  );
  assert.deepEqual(
    source.externalStateSource.getWorkspaceState({
      workspaceId: "workspace-1"
    }),
    {
      workspaceId: "workspace-1"
    }
  );
});

test("desktop issue-manager node state source ignores other type ids", (t) => {
  const restore = installFailingLocalStorage();
  t.after(restore);

  const source = createDesktopIssueManagerNodeStateSource({
    workspaceId: "workspace-1"
  });
  source.writeNodeState({
    instanceId: "node-1",
    state: {
      issueSearchQuery: "ignored",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: null,
      selectedTaskId: null
    },
    typeId: "browser"
  });

  assert.equal(
    source.externalStateSource.getNodeState({
      instanceId: "node-1",
      nodeId: "node-1",
      typeId: "browser",
      workspaceId: "workspace-1"
    }),
    null
  );
  assert.equal(
    source.externalStateSource.getNodeState({
      instanceId: "missing-node",
      nodeId: "missing-node",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    null
  );
  assert.equal(
    source.externalStateSource.getSnapshotNodeState?.({
      instanceId: "missing-node",
      nodeId: "missing-node",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    null
  );
});

test("desktop issue-manager node state source drops non-whitelisted updates", (t) => {
  const restore = installFailingLocalStorage();
  t.after(restore);

  const source = createDesktopIssueManagerNodeStateSource({
    workspaceId: "workspace-1"
  });
  let notifyCount = 0;
  const unsubscribe = source.externalStateSource.subscribe?.(() => {
    notifyCount += 1;
  });
  assert.ok(unsubscribe);
  t.after(unsubscribe);

  source.writeNodeState({
    instanceId: "node-1",
    state: {
      issueDraftContent: null,
      issueDraftTitle: null,
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedExecutionDirectory: null,
      selectedIssueId: "issue-1",
      selectedTaskId: null,
      taskDraftContent: null,
      taskDraftTitle: null,
      taskListCollapsed: false
    },
    typeId: "issue-manager"
  });

  source.writeNodeState({
    instanceId: "node-1",
    state: {
      issueDraftContent: null,
      issueDraftTitle: null,
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedExecutionDirectory: null,
      selectedIssueId: "issue-1",
      selectedTaskId: null,
      taskDraftContent: "拼音 composing",
      taskDraftTitle: "任务草稿",
      taskListCollapsed: false
    },
    typeId: "issue-manager"
  });

  assert.equal(notifyCount, 1);
  assert.deepEqual(
    source.externalStateSource.getNodeState({
      instanceId: "node-1",
      nodeId: "node-1",
      typeId: "issue-manager",
      workspaceId: "workspace-1"
    }),
    {
      issueSearchQuery: "",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedExecutionDirectory: null,
      selectedIssueId: "issue-1",
      selectedTaskId: null,
      taskListCollapsed: false
    }
  );

  source.writeNodeState({
    instanceId: "node-1",
    state: {
      issueDraftContent: null,
      issueDraftTitle: null,
      issueSearchQuery: "updated",
      issueStatusFilter: "all",
      selectedAgentTargetId: "local:codex",
      selectedIssueId: "issue-1",
      selectedTaskId: null,
      taskDraftContent: "拼音 composing",
      taskDraftTitle: "任务草稿",
      taskListCollapsed: false
    },
    typeId: "issue-manager"
  });

  assert.equal(notifyCount, 2);
});

function installFailingLocalStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("localStorage should not be accessed");
    }
  });

  return () => {
    if (!original) {
      Reflect.deleteProperty(globalThis, "localStorage");
      return;
    }
    Object.defineProperty(globalThis, "localStorage", original);
  };
}
