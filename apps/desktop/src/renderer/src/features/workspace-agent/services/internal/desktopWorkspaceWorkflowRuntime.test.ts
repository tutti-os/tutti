import assert from "node:assert/strict";
import test from "node:test";
import type {
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
        phase: "task_graph",
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
        tasks: [
          {
            id: "task-1",
            title: "Implement",
            content: "",
            priority: "medium",
            agentTargetId: null,
            modelPlanId: null,
            model: null,
            permissionModeId: null,
            reasoningEffort: null,
            executionDirectory: null,
            dependsOn: [],
            parallelizable: true
          }
        ]
      }
    }
  ],
  checkpoints: [
    {
      id: "checkpoint-1",
      workflowId: "workflow-1",
      kind: "task_review",
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
      async listPendingWorkspaceWorkflows(
        workspaceId: string,
        sourceSessionId: string
      ) {
        calls.push(["list", workspaceId, sourceSessionId]);
        return [snapshot];
      },
      async decideWorkspaceWorkflowCheckpoint(
        workspaceId: string,
        workflowId: string,
        checkpointId: string,
        request: unknown
      ) {
        calls.push(["decide", workspaceId, workflowId, checkpointId, request]);
        return snapshot;
      }
    } as never,
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
  await runtime.decide({
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    checkpointId: "checkpoint-1",
    decision: "accepted",
    decidedBy: "user-1",
    taskAssignments: [
      {
        taskId: "task-1",
        agentTargetId: "agent-1",
        modelPlanId: "",
        model: "",
        permissionModeId: "",
        reasoningEffort: ""
      }
    ]
  });
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
        reason: "Revise the task graph",
        taskAssignments: undefined
      }
    ],
    [
      "decide",
      "workspace-1",
      "workflow-1",
      "checkpoint-1",
      {
        decision: "accepted",
        decidedBy: "user-1",
        reason: undefined,
        taskAssignments: [
          {
            taskId: "task-1",
            agentTargetId: "agent-1",
            modelPlanId: "",
            model: "",
            permissionModeId: "",
            reasoningEffort: ""
          }
        ]
      }
    ]
  ]);
});

test("desktop workflow runtime builds agent-scoped assignment option catalogs", async () => {
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {
      async listPendingWorkspaceWorkflows() {
        return [];
      },
      async decideWorkspaceWorkflowCheckpoint() {
        return snapshot;
      },
      async listAgentTargets() {
        return {
          defaultAgentTargetId: "codex",
          targets: [
            {
              id: "codex",
              provider: "codex",
              launchRef: { type: "builtin", value: "codex" },
              name: "Codex",
              enabled: true,
              source: "system",
              sortOrder: 1,
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1
            },
            {
              id: "disabled-agent",
              provider: "codex",
              launchRef: { type: "builtin", value: "codex" },
              name: "Disabled",
              enabled: false,
              source: "system",
              sortOrder: 2,
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1
            }
          ]
        } as never;
      },
      async listWorkspaceAgents(workspaceId: string) {
        assert.equal(workspaceId, "workspace-1");
        return {
          agents: [
            {
              id: "workspace-agent:openrouter",
              agentTargetId: "workspace-agent:openrouter",
              workspaceId,
              name: "OpenRouter",
              description: "",
              harness: {
                agentTargetId: "codex",
                available: true,
                enabled: true,
                provider: "codex"
              },
              modelFallbacks: [],
              instructions: "",
              callConditions: [],
              capabilitiesExplicit: false,
              skills: [],
              tools: [],
              source: "user",
              revision: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z"
            },
            {
              id: "workspace-agent:disabled",
              agentTargetId: "workspace-agent:disabled",
              workspaceId,
              name: "Disabled workspace agent",
              description: "",
              harness: {
                agentTargetId: "codex",
                available: true,
                enabled: false,
                provider: "codex"
              },
              modelFallbacks: [],
              instructions: "",
              callConditions: [],
              capabilitiesExplicit: false,
              skills: [],
              tools: [],
              source: "user",
              revision: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z"
            },
            {
              id: "workspace-agent:broken-harness",
              agentTargetId: "workspace-agent:broken-harness",
              workspaceId,
              name: "Broken harness agent",
              description: "",
              harness: {
                agentTargetId: "gone",
                available: false,
                enabled: true,
                provider: "codex"
              },
              modelFallbacks: [],
              instructions: "",
              callConditions: [],
              capabilitiesExplicit: false,
              skills: [],
              tools: [],
              source: "user",
              revision: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z"
            }
          ]
        } as never;
      },
      async getAgentProviderComposerOptions(
        provider: string,
        request?: { agentTargetId?: string }
      ) {
        assert.equal(provider, "codex");
        assert.equal(request?.agentTargetId, "workspace-agent:openrouter");
        return {
          modelConfig: {
            configurable: true,
            options: [{ id: "gpt", value: "gpt-5.4", label: "GPT-5.4" }]
          },
          permissionConfig: {
            configurable: true,
            modes: [{ id: "auto", label: "Auto", semantic: "auto" }]
          },
          reasoningConfig: {
            configurable: true,
            options: [{ id: "high", value: "high", label: "High" }]
          }
        } as never;
      },
      async listModelPlans(workspaceId: string) {
        assert.equal(workspaceId, "workspace-1");
        return {
          plans: [
            {
              id: "plan-openai",
              name: "OpenAI plan",
              protocol: "openai",
              enabled: true,
              status: "ready",
              models: [{ id: "gpt-5.4", name: "GPT-5.4" }]
            },
            {
              id: "plan-anthropic",
              name: "Anthropic plan",
              protocol: "anthropic",
              enabled: true,
              status: "ready",
              models: [{ id: "claude", name: "Claude" }]
            },
            {
              id: "plan-disabled",
              name: "Disabled plan",
              protocol: "openai",
              enabled: false,
              status: "ready",
              models: [{ id: "gpt-5.4", name: "GPT-5.4" }]
            }
          ]
        } as never;
      }
    } as never,
    eventStreamClient: null
  });

  const agents = await runtime.assignmentOptions!.listAgents({
    workspaceId: "workspace-1"
  });
  // Built-in Harness targets and enabled workspace Agents coexist; disabled
  // or harness-broken workspace Agents stay out (P1 regression anchor).
  assert.deepEqual(agents, [
    { agentTargetId: "codex", label: "Codex" },
    { agentTargetId: "workspace-agent:openrouter", label: "OpenRouter" }
  ]);

  const detail = await runtime.assignmentOptions!.loadAgentOptions({
    workspaceId: "workspace-1",
    agentTargetId: "workspace-agent:openrouter"
  });
  assert.deepEqual(detail.models, ["gpt-5.4"]);
  assert.deepEqual(detail.modelPlans, [
    { modelPlanId: "plan-openai", label: "OpenAI plan", models: ["gpt-5.4"] }
  ]);
  assert.deepEqual(detail.permissionModes, [{ id: "auto", label: "Auto" }]);
  assert.deepEqual(detail.reasoningEfforts, ["high"]);

  const unknown = await runtime.assignmentOptions!.loadAgentOptions({
    workspaceId: "workspace-1",
    agentTargetId: "missing"
  });
  assert.deepEqual(unknown, {
    models: [],
    modelPlans: [],
    permissionModes: [],
    reasoningEfforts: []
  });
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
    tuttidClient: {} as never,
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
    tuttidClient: {} as never,
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
