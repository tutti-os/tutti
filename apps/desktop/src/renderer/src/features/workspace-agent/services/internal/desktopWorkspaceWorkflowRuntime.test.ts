import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentActivityUpdatedEventV1,
  TuttidEventStreamClient,
  WorkspaceWorkflowSnapshot,
  WorkspaceWorkflowUpdatedEventV1
} from "@tutti-os/client-tuttid-ts";
import {
  createDesktopTuttiModePlanReviewRuntime as createRuntimeUnderTest,
  type DesktopTuttiModePlanReviewRuntimeInput
} from "./desktopWorkspaceWorkflowRuntime.ts";

type TestRuntimeInput = Omit<
  DesktopTuttiModePlanReviewRuntimeInput,
  "composerOptionsRuntime"
> & {
  composerOptionsRuntime?: DesktopTuttiModePlanReviewRuntimeInput["composerOptionsRuntime"];
};

function createDesktopTuttiModePlanReviewRuntime(
  input: TestRuntimeInput
): ReturnType<typeof createRuntimeUnderTest> {
  return createRuntimeUnderTest({
    ...input,
    composerOptionsRuntime: input.composerOptionsRuntime ?? {
      async getComposerOptions() {
        throw new Error("composer options are not used by this test");
      }
    }
  });
}

interface AgentModelCatalogInvalidatedEvent {
  id: string;
  version: 1;
  topic: "agent.model.catalog.invalidated";
  emittedAt: string;
  payload: {
    providers: readonly string[];
    occurredAtUnixMs: number;
  };
}

interface AgentModelConfigurationChangedEvent {
  id: string;
  version: 1;
  topic: "agent.model.configuration.changed";
  emittedAt: string;
  scope?: { workspaceId?: string };
  payload: {
    workspaceId: string;
    agentTargetIds: readonly string[];
    defaultModels: Record<string, string>;
    resetComposerModel: boolean;
    occurredAtUnixMs: number;
  };
}

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
            parallelizable: true,
            autoAccept: true
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
    composerOptionsRuntime: {
      async getComposerOptions(input) {
        assert.equal(input.provider, "codex");
        assert.equal(input.agentTargetId, "workspace-agent:openrouter");
        return {
          provider: "codex",
          models: [{ value: "gpt-5.4", label: "GPT-5.4" }],
          permissionConfig: {
            configurable: true,
            modes: [{ id: "auto", label: "Auto", semantic: "auto" }]
          },
          reasoningEfforts: [{ value: "high", label: "High" }]
        } as never;
      }
    },
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
  assert.deepEqual(detail.models, [{ value: "gpt-5.4", label: "GPT-5.4" }]);
  assert.deepEqual(detail.modelPlans, [
    {
      modelPlanId: "plan-openai",
      label: "OpenAI plan",
      models: [{ value: "gpt-5.4", label: "GPT-5.4" }]
    }
  ]);
  assert.deepEqual(detail.permissionModes, [{ id: "auto", label: "Auto" }]);
  assert.deepEqual(detail.reasoningEfforts, [{ value: "high", label: "High" }]);

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

function createRecordingEventStreamClient(): {
  eventStreamClient: Pick<
    TuttidEventStreamClient,
    "connect" | "subscribe" | "subscribeConnectionState"
  >;
  connectCount: () => number;
  subscribedScopes: ReadonlyMap<string, unknown>;
  emitWorkflowEvent: (event: WorkspaceWorkflowUpdatedEventV1) => void;
  emitActivityEvent: (event: AgentActivityUpdatedEventV1) => void;
  emitModelCatalogEvent: (event: AgentModelCatalogInvalidatedEvent) => void;
  emitModelConfigurationEvent: (
    event: AgentModelConfigurationChangedEvent
  ) => void;
} {
  let connectCount = 0;
  const subscribedScopes = new Map<string, unknown>();
  const listenersByTopic = new Map<string, (event: never) => void>();
  const eventStreamClient = {
    async connect() {
      connectCount += 1;
    },
    subscribe(topic, listener, options) {
      listenersByTopic.set(topic, listener as (event: never) => void);
      subscribedScopes.set(topic, options?.scope);
      return () => undefined;
    },
    subscribeConnectionState() {
      return () => undefined;
    }
  } as Pick<
    TuttidEventStreamClient,
    "connect" | "subscribe" | "subscribeConnectionState"
  >;
  return {
    eventStreamClient,
    connectCount: () => connectCount,
    subscribedScopes,
    emitWorkflowEvent: (event) => {
      (
        listenersByTopic.get("workspace.workflow.updated") as
          | ((event: WorkspaceWorkflowUpdatedEventV1) => void)
          | undefined
      )?.(event);
    },
    emitActivityEvent: (event) => {
      (
        listenersByTopic.get("agent.activity.updated") as
          | ((event: AgentActivityUpdatedEventV1) => void)
          | undefined
      )?.(event);
    },
    emitModelCatalogEvent: (event) => {
      (
        listenersByTopic.get("agent.model.catalog.invalidated") as
          | ((event: AgentModelCatalogInvalidatedEvent) => void)
          | undefined
      )?.(event);
    },
    emitModelConfigurationEvent: (event) => {
      (
        listenersByTopic.get("agent.model.configuration.changed") as
          | ((event: AgentModelConfigurationChangedEvent) => void)
          | undefined
      )?.(event);
    }
  };
}

test("assignment option cache deduplicates loads and fences invalidated results", async () => {
  const stream = createRecordingEventStreamClient();
  let composerLoadCount = 0;
  const composerOptions = (model: string) => ({
    provider: "codex",
    models: [{ value: model, label: model.toUpperCase() }],
    permissionConfig: {
      configurable: true,
      modes: [{ id: "auto", label: "Auto", semantic: "auto" }]
    },
    reasoningEfforts: [{ value: "high", label: "High" }]
  });
  let resolveFirstComposerLoad:
    | ((value: ReturnType<typeof composerOptions>) => void)
    | undefined;
  let markFirstComposerLoadStarted: (() => void) | undefined;
  const firstComposerLoadStarted = new Promise<void>((resolve) => {
    markFirstComposerLoadStarted = resolve;
  });
  const firstComposerLoad = new Promise<ReturnType<typeof composerOptions>>(
    (resolve) => {
      resolveFirstComposerLoad = resolve;
    }
  );
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    composerOptionsRuntime: {
      async getComposerOptions() {
        composerLoadCount += 1;
        if (composerLoadCount === 1) {
          markFirstComposerLoadStarted?.();
          return firstComposerLoad as never;
        }
        return composerOptions(`gpt-${composerLoadCount}`) as never;
      }
    },
    tuttidClient: {
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
            }
          ]
        } as never;
      },
      async listWorkspaceAgents() {
        return { agents: [] } as never;
      },
      async listModelPlans() {
        return { plans: [] } as never;
      }
    } as never,
    eventStreamClient: stream.eventStreamClient
  });
  const invalidations: unknown[] = [];
  runtime.subscribe("workspace-1", (update) => invalidations.push(update));

  const loadInput = {
    workspaceId: "workspace-1",
    agentTargetId: "codex"
  };
  const first = runtime.assignmentOptions!.loadAgentOptions(loadInput);
  const duplicate = runtime.assignmentOptions!.loadAgentOptions(loadInput);
  await firstComposerLoadStarted;
  assert.equal(composerLoadCount, 1);

  stream.emitModelConfigurationEvent({
    id: "model-configuration-1",
    version: 1,
    topic: "agent.model.configuration.changed",
    emittedAt: "2026-07-28T00:00:00.000Z",
    scope: { workspaceId: "workspace-1" },
    payload: {
      workspaceId: "workspace-1",
      agentTargetIds: ["codex"],
      defaultModels: { codex: "gpt-2" },
      resetComposerModel: false,
      occurredAtUnixMs: 1
    }
  });
  const afterInvalidation =
    runtime.assignmentOptions!.loadAgentOptions(loadInput);
  resolveFirstComposerLoad?.(composerOptions("stale"));

  const results = await Promise.all([first, duplicate, afterInvalidation]);
  assert.equal(composerLoadCount, 2);
  for (const result of results) {
    assert.deepEqual(result.models, [{ value: "gpt-2", label: "GPT-2" }]);
  }
  assert.deepEqual(
    runtime.assignmentOptions!.readAgentOptions?.(loadInput)?.models,
    [{ value: "gpt-2", label: "GPT-2" }]
  );
  assert.deepEqual(invalidations, [
    {
      kind: "assignment_options_invalidated",
      workspaceId: "workspace-1",
      agentTargetIds: ["codex"]
    }
  ]);

  await runtime.assignmentOptions!.loadAgentOptions(loadInput);
  assert.equal(composerLoadCount, 2, "fresh detail should be reused");

  stream.emitModelCatalogEvent({
    id: "model-catalog-1",
    version: 1,
    topic: "agent.model.catalog.invalidated",
    emittedAt: "2026-07-28T00:01:00.000Z",
    payload: {
      providers: ["codex"],
      occurredAtUnixMs: 2
    }
  });
  assert.deepEqual(
    runtime.assignmentOptions!.readAgentOptions?.(loadInput)?.models,
    [{ value: "gpt-2", label: "GPT-2" }],
    "stale data remains readable while the refresh is pending"
  );
  assert.deepEqual(
    (await runtime.assignmentOptions!.loadAgentOptions(loadInput)).models,
    [{ value: "gpt-3", label: "GPT-3" }]
  );
  assert.equal(composerLoadCount, 3);
});

test("desktop workflow runtime scopes workflow events to the workspace", async () => {
  const stream = createRecordingEventStreamClient();
  const eventListener = stream.emitWorkflowEvent;
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {} as never,
    eventStreamClient: stream.eventStreamClient
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

  assert.equal(stream.connectCount(), 1);
  assert.deepEqual(stream.subscribedScopes.get("workspace.workflow.updated"), {
    workspaceId: "workspace-1"
  });
  assert.deepEqual(stream.subscribedScopes.get("agent.activity.updated"), {
    workspaceId: "workspace-1"
  });
  assert.deepEqual(
    stream.subscribedScopes.get("agent.model.configuration.changed"),
    { workspaceId: "workspace-1" }
  );
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

test("desktop workflow runtime relays only settled turn updates as session_settled", async () => {
  const stream = createRecordingEventStreamClient();
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {} as never,
    eventStreamClient: stream.eventStreamClient
  });
  const updates: unknown[] = [];

  runtime.subscribe("workspace-1", (update) => updates.push(update));
  await Promise.resolve();
  const activityEvent = (
    phase: "running" | "settled",
    scopeWorkspaceId: string
  ): AgentActivityUpdatedEventV1 => ({
    id: `event-${phase}-${scopeWorkspaceId}`,
    version: 2,
    topic: "agent.activity.updated",
    emittedAt: "2026-07-16T00:00:00.000Z",
    scope: { workspaceId: scopeWorkspaceId },
    payload: {
      workspaceId: scopeWorkspaceId,
      agentSessionId: "session-1",
      eventType: "turn_update",
      data: {
        workspaceId: scopeWorkspaceId,
        agentSessionId: "session-1",
        eventType: "turn_update",
        occurredAtUnixMs: 1,
        activeTurnId: phase === "settled" ? null : "turn-1",
        turn: {
          turnId: "turn-1",
          agentSessionId: "session-1",
          phase,
          outcome: phase === "settled" ? "completed" : null,
          origin: "user_prompt",
          error: null,
          fileChanges: null,
          completedCommand: null,
          startedAtUnixMs: 1,
          settledAtUnixMs: phase === "settled" ? 2 : null,
          updatedAtUnixMs: 2
        }
      }
    }
  });

  // Mid-turn updates and other workspaces' settles must not fire read-repair.
  stream.emitActivityEvent(activityEvent("running", "workspace-1"));
  stream.emitActivityEvent(activityEvent("settled", "workspace-2"));
  stream.emitActivityEvent(activityEvent("settled", "workspace-1"));

  assert.deepEqual(updates, [
    {
      kind: "session_settled",
      workspaceId: "workspace-1",
      sourceSessionId: "session-1"
    }
  ]);
});

test("plan issue source tolerates the daemon omitting empty dependency arrays", async () => {
  // The daemon omits empty arrays, so a task with no dependencies arrives with
  // dependencyTaskIds undefined even though the generated type declares it
  // required. Spreading undefined used to throw here, reject getSessionPlanIssue,
  // and leave the embedded panel permanently empty (the first task of every
  // plan has no dependencies, so this fired on every plan).
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {
      async listWorkspaceWorkflows() {
        return [
          {
            ...snapshot,
            workflow: {
              ...snapshot.workflow,
              status: "accepted",
              updatedAtUnixMs: 100
            },
            operations: [
              {
                id: "operation-1",
                workflowId: "workflow-1",
                kind: "create_issue",
                status: "succeeded",
                revisionId: "revision-1",
                issueId: "tutti-mode-plan-1",
                errorCode: null,
                errorMessage: null,
                createdAtUnixMs: 90,
                updatedAtUnixMs: 100,
                startedAtUnixMs: 90,
                completedAtUnixMs: 100
              }
            ]
          }
        ];
      },
      async getWorkspaceIssueDetail() {
        return {
          issue: {
            issueId: "tutti-mode-plan-1",
            topicId: "default",
            title: "Plan issue",
            dispatchPaused: true
          },
          tasks: [
            // No dependencyTaskIds field at all — the exact daemon shape.
            {
              taskId: "task-1",
              title: "First",
              content: "",
              status: "running",
              sortIndex: 1,
              parallelizable: true,
              autoAccept: true
            },
            {
              taskId: "task-2",
              title: "Second",
              content: "",
              status: "not_started",
              sortIndex: 2,
              parallelizable: false,
              autoAccept: false,
              dependencyTaskIds: ["task-1"]
            }
          ]
        };
      }
    } as never,
    eventStreamClient: null
  });

  const result = await runtime.planIssues!.getSessionPlanIssue({
    workspaceId: "workspace-1",
    sourceSessionId: "session-1"
  });
  assert.ok(result, "expected the plan issue to resolve, not reject");
  assert.equal(result.kind, "issue");
  const issue = result.kind === "issue" ? result.issue : null;
  assert.ok(issue);
  assert.equal(issue.workflowId, "workflow-1");
  assert.equal(issue.sourceTurnId, "turn-1");
  assert.equal(issue.issueId, "tutti-mode-plan-1");
  assert.equal(issue.dispatchPaused, true);
  assert.deepEqual(
    issue.tasks.map((task) => task.dependencyTaskIds),
    [[], ["task-1"]]
  );
});

test("plan issue source surfaces a durably failed create_issue operation", async () => {
  // An accepted workflow whose create_issue failed has no pending checkpoint
  // and no Issue; the conversation must render the failure instead of nothing.
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {
      async listWorkspaceWorkflows() {
        return [
          {
            ...snapshot,
            workflow: {
              ...snapshot.workflow,
              status: "accepted",
              updatedAtUnixMs: 100
            },
            operations: [
              {
                id: "operation-1",
                workflowId: "workflow-1",
                kind: "create_issue",
                status: "failed",
                revisionId: "revision-1",
                errorCode: "issue_materialization_failed",
                errorMessage: "issue manager argument is invalid",
                createdAtUnixMs: 90,
                updatedAtUnixMs: 100,
                startedAtUnixMs: 90,
                completedAtUnixMs: 100
              }
            ]
          }
        ];
      }
    } as never,
    eventStreamClient: null
  });

  const result = await runtime.planIssues!.getSessionPlanIssue({
    workspaceId: "workspace-1",
    sourceSessionId: "session-1"
  });
  assert.deepEqual(result, {
    kind: "materialization_failed",
    workflowId: "workflow-1",
    sourceTurnId: "turn-1",
    errorMessage: "issue manager argument is invalid"
  });
});

test("plan issue source stops execution through the Tutti-specific contract", async () => {
  const calls: unknown[] = [];
  const runtime = createDesktopTuttiModePlanReviewRuntime({
    tuttidClient: {
      async cancelTuttiModeExecution(workspaceId: string, issueId: string) {
        calls.push([workspaceId, issueId]);
        return { canceledRunCount: 2 };
      }
    } as never,
    eventStreamClient: null
  });

  await runtime.planIssues!.cancelExecution({
    workspaceId: "workspace-1",
    issueId: "tutti-mode-plan-1"
  });

  assert.deepEqual(calls, [["workspace-1", "tutti-mode-plan-1"]]);
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
