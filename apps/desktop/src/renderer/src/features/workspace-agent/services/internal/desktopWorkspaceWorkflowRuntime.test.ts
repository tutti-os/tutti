import assert from "node:assert/strict";
import test from "node:test";
import type {
  TuttidClient,
  TuttidEventStreamClient,
  WorkspaceWorkflowSnapshot,
  WorkspaceWorkflowUpdatedEventV1
} from "@tutti-os/client-tuttid-ts";
import { createDesktopTuttiModePlanReviewRuntime } from "./desktopWorkspaceWorkflowRuntime.ts";

const snapshot: WorkspaceWorkflowSnapshot = {
  workflow: {
    id: "workflow-1",
    workspaceId: "workspace-1",
    type: "tutti_mode_plan",
    owner: "tutti",
    triggerKind: "agent_cli",
    sourceSessionId: "session-1",
    sourceTurnId: "turn-1",
    sourceToolCallId: "tool-1",
    status: "pending_review",
    currentRevisionId: "revision-1",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2
  },
  revisions: [
    {
      id: "revision-1",
      workflowId: "workflow-1",
      sequence: 1,
      schemaVersion: "tutti-mode-plan/v1",
      documentPath: "opaque.md",
      sha256: "a".repeat(64),
      producedByTurnId: "turn-1",
      createdAtUnixMs: 1,
      document: {
        schema: "tutti-mode-plan/v1",
        phase: "configuration",
        title: "Review",
        topicId: "topic-1",
        markdownBody: "Body",
        execution: {
          mode: "sequential",
          reasoningIntensity: 50,
          orchestrationIntensity: 50
        },
        budget: {
          mode: "auto",
          tokenLimit: 0,
          quotaWaterlinePercent: 0
        },
        tasks: []
      }
    }
  ],
  checkpoints: [
    {
      id: "checkpoint-1",
      workflowId: "workflow-1",
      kind: "configuration_review",
      revisionId: "revision-1",
      status: "pending",
      decidedBy: null,
      decisionReason: null,
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
      decidedAtUnixMs: null
    }
  ],
  turnLinks: [
    {
      workflowId: "workflow-1",
      turnId: "turn-1",
      relation: "source",
      createdAtUnixMs: 1
    }
  ],
  operations: [],
  actionableItems: []
};

const reviewSnapshot = {
  workflow: {
    id: "workflow-1",
    workspaceId: "workspace-1",
    type: "tutti_mode_plan",
    owner: "tutti",
    triggerKind: "agent_cli",
    sourceSessionId: "session-1",
    sourceTurnId: "turn-1",
    sourceToolCallId: "tool-1",
    status: "pending_review",
    currentRevisionId: "revision-1"
  },
  revisions: snapshot.revisions,
  checkpoints: snapshot.checkpoints
};

test("desktop workflow runtime pulls pending state and forwards user decisions", async () => {
  const calls: unknown[] = [];
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {
      async listPendingWorkspaceWorkflows(workspaceId, sourceSessionId) {
        calls.push(["list", workspaceId, sourceSessionId]);
        return [snapshot];
      },
      async decideWorkspaceWorkflowCheckpoint(
        workspaceId,
        workflowId,
        checkpointId,
        request
      ) {
        calls.push(["decide", workspaceId, workflowId, checkpointId, request]);
        return snapshot;
      }
    } satisfies Pick<
      TuttidClient,
      "listPendingWorkspaceWorkflows" | "decideWorkspaceWorkflowCheckpoint"
    >,
    eventStreamClient: null
  });

  assert.deepEqual(
    await runtime.listPending({
      workspaceId: "workspace-1",
      sourceSessionId: "session-1"
    }),
    [reviewSnapshot]
  );
  assert.equal(
    await runtime.decide({
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      checkpointId: "checkpoint-1",
      decision: "rejected",
      decidedBy: "user-1",
      reason: "Revise the task graph"
    }),
    undefined
  );
  assert.deepEqual(calls, [
    ["list", "workspace-1", "session-1"],
    [
      "decide",
      "workspace-1",
      "workflow-1",
      "checkpoint-1",
      {
        decision: "rejected",
        decidedBy: "user-1",
        reason: "Revise the task graph"
      }
    ]
  ]);
});

test("desktop workflow runtime scopes workflow events to the workspace", async () => {
  let connectCount = 0;
  let subscribedTopic = "";
  let subscribedScope: unknown;
  let eventListener:
    | ((event: WorkspaceWorkflowUpdatedEventV1) => void)
    | undefined;
  const eventStreamClient = {
    async connect() {
      connectCount += 1;
    },
    subscribe(topic, listener, options) {
      subscribedTopic = topic;
      eventListener = listener as (
        event: WorkspaceWorkflowUpdatedEventV1
      ) => void;
      subscribedScope = options?.scope;
      return () => undefined;
    },
    subscribeConnectionState() {
      return () => undefined;
    }
  } as Pick<
    TuttidEventStreamClient,
    "connect" | "subscribe" | "subscribeConnectionState"
  >;
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {} as Pick<
      TuttidClient,
      "listPendingWorkspaceWorkflows" | "decideWorkspaceWorkflowCheckpoint"
    >,
    eventStreamClient
  });
  const updates: unknown[] = [];

  runtime.subscribe("workspace-1", (update) => updates.push(update));
  await Promise.resolve();
  eventListener?.({
    id: "event-without-scope",
    version: 1,
    topic: "workspace.workflow.updated",
    emittedAt: "2026-07-16T00:00:00.000Z",
    payload: {
      workflowId: "workflow-1",
      sourceSessionId: "session-1",
      checkpointId: "checkpoint-1",
      changeKind: "proposal_created"
    }
  });
  eventListener?.({
    id: "event-1",
    version: 1,
    topic: "workspace.workflow.updated",
    emittedAt: "2026-07-16T00:00:00.000Z",
    scope: { workspaceId: "workspace-1" },
    payload: {
      workflowId: "workflow-1",
      sourceSessionId: "session-1",
      checkpointId: "checkpoint-1",
      changeKind: "proposal_created"
    }
  });

  assert.equal(connectCount, 1);
  assert.equal(subscribedTopic, "workspace.workflow.updated");
  assert.deepEqual(subscribedScope, { workspaceId: "workspace-1" });
  assert.deepEqual(updates, [
    {
      kind: "workflow_updated",
      workspaceId: "workspace-1",
      workflowId: "workflow-1",
      sourceSessionId: "session-1",
      checkpointId: "checkpoint-1",
      changeKind: "proposal_created"
    }
  ]);
});

test("desktop workflow runtime invalidates current scopes on every connected state", async () => {
  let connectionListener: ((state: string) => void) | undefined;
  const eventStreamClient = {
    async connect() {},
    subscribe() {
      return () => undefined;
    },
    subscribeConnectionState(listener: (state: string) => void) {
      connectionListener = listener;
      return () => undefined;
    }
  } as Pick<
    TuttidEventStreamClient,
    "connect" | "subscribe" | "subscribeConnectionState"
  >;
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {} as Pick<
      TuttidClient,
      "listPendingWorkspaceWorkflows" | "decideWorkspaceWorkflowCheckpoint"
    >,
    eventStreamClient
  });
  const invalidations: unknown[] = [];

  runtime.subscribe("workspace-1", (update) => invalidations.push(update));
  connectionListener?.("connected");
  connectionListener?.("disconnected");
  connectionListener?.("connected");

  assert.deepEqual(invalidations, [
    { kind: "connection_restored", workspaceId: "workspace-1" },
    { kind: "connection_restored", workspaceId: "workspace-1" }
  ]);
});
