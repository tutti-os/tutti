import { describe, expect, it } from "vitest";
import {
  projectTuttiModePlanPanel,
  type TuttiModePlanReviewSnapshot
} from "./tuttiModePlanPanelProjection";

function configurationSnapshot(
  overrides: Partial<TuttiModePlanReviewSnapshot> = {}
): TuttiModePlanReviewSnapshot {
  return {
    workflow: {
      id: "workflow-1",
      workspaceId: "workspace-1",
      type: "tutti_mode_plan",
      owner: "tutti",
      triggerKind: "agent_cli",
      sourceSessionId: "session-1",
      sourceTurnId: "turn-1",
      sourceToolCallId: "tool-call-1",
      status: "pending_review",
      currentRevisionId: "revision-1"
    },
    revisions: [
      {
        id: "revision-1",
        workflowId: "workflow-1",
        sequence: 1,
        schemaVersion: "tutti-mode-plan/v1",
        documentPath: `tutti-mode-plans/workflow-1/revisions/${"a".repeat(64)}.md`,
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        producedByTurnId: "turn-1",
        createdAtUnixMs: 110,
        document: {
          schema: "tutti-mode-plan/v1",
          phase: "configuration",
          title: "Ship the workflow",
          topicId: "topic-1",
          markdownBody: "## Goal\n\nShip the durable workflow safely.",
          execution: {
            mode: "sequential",
            reasoningIntensity: 70,
            orchestrationIntensity: 60
          },
          budget: {
            mode: "fixed",
            tokenLimit: 120_000,
            quotaWaterlinePercent: 15
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
        createdAtUnixMs: 120,
        updatedAtUnixMs: 120,
        decidedAtUnixMs: null
      }
    ],
    ...overrides
  };
}

describe("projectTuttiModePlanPanel", () => {
  it("projects a pending configuration review from durable workflow state", () => {
    expect(projectTuttiModePlanPanel(configurationSnapshot())).toEqual({
      id: "workflow-1:checkpoint-1",
      workflowId: "workflow-1",
      workspaceId: "workspace-1",
      sourceSessionId: "session-1",
      sourceTurnId: "turn-1",
      sourceToolCallId: "tool-call-1",
      reviewKind: "configuration_review",
      state: "pending",
      actionable: true,
      title: "Ship the workflow",
      topicId: "topic-1",
      markdownBody: "## Goal\n\nShip the durable workflow safely.",
      revision: {
        id: "revision-1",
        sequence: 1,
        schemaVersion: "tutti-mode-plan/v1",
        documentPath: `tutti-mode-plans/workflow-1/revisions/${"a".repeat(64)}.md`,
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        producedByTurnId: "turn-1",
        createdAtUnixMs: 110
      },
      checkpoint: {
        id: "checkpoint-1",
        status: "pending",
        decidedBy: null,
        decisionReason: null,
        decidedAtUnixMs: null,
        createdAtUnixMs: 120,
        updatedAtUnixMs: 120
      },
      execution: {
        mode: "sequential",
        reasoningIntensity: 70,
        orchestrationIntensity: 60
      },
      budget: {
        mode: "fixed",
        tokenLimit: 120_000,
        quotaWaterlinePercent: 15
      },
      tasks: []
    });
  });

  it("projects only the current task-graph revision and keeps dependency identity", () => {
    const snapshot = configurationSnapshot();
    snapshot.workflow.currentRevisionId = "revision-2";
    snapshot.revisions = [
      ...snapshot.revisions,
      {
        id: "revision-2",
        workflowId: "workflow-1",
        sequence: 2,
        schemaVersion: "tutti-mode-plan/v1",
        documentPath: `tutti-mode-plans/workflow-1/revisions/${"b".repeat(64)}.md`,
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        producedByTurnId: "turn-2",
        createdAtUnixMs: 210,
        document: {
          schema: "tutti-mode-plan/v1",
          phase: "task_graph",
          title: "Ship the workflow",
          topicId: "topic-1",
          markdownBody: "## Tasks\n\nImplement and verify the workflow.",
          execution: {
            mode: "parallel",
            reasoningIntensity: 80,
            orchestrationIntensity: 90
          },
          budget: {
            mode: "auto",
            tokenLimit: 200_000,
            quotaWaterlinePercent: 10
          },
          tasks: [
            {
              id: "design",
              title: "Design",
              content: "Define contracts",
              priority: "high",
              agentTargetId: "local:codex",
              modelPlanId: "model-plan-1",
              model: "gpt-5.4",
              executionDirectory: "packages/agent/gui",
              dependsOn: []
            },
            {
              id: "build",
              title: "Build",
              content: "Implement the contracts",
              priority: "medium",
              agentTargetId: null,
              modelPlanId: null,
              model: null,
              executionDirectory: null,
              dependsOn: ["design"]
            }
          ]
        }
      }
    ];
    snapshot.checkpoints = [
      {
        ...snapshot.checkpoints[0]!,
        status: "superseded",
        updatedAtUnixMs: 205
      },
      {
        id: "checkpoint-2",
        workflowId: "workflow-1",
        kind: "task_review",
        revisionId: "revision-2",
        status: "accepted",
        decidedBy: "user-1",
        decisionReason: "Ready to execute",
        createdAtUnixMs: 220,
        updatedAtUnixMs: 230,
        decidedAtUnixMs: 230
      }
    ];

    const panel = projectTuttiModePlanPanel(snapshot);

    expect(panel).toMatchObject({
      id: "workflow-1:checkpoint-2",
      reviewKind: "task_review",
      state: "accepted",
      actionable: false,
      revision: { id: "revision-2", sequence: 2 },
      checkpoint: {
        id: "checkpoint-2",
        decisionReason: "Ready to execute"
      },
      tasks: [
        {
          ordinal: 1,
          id: "design",
          dependsOn: [],
          agentTargetId: "local:codex"
        },
        {
          ordinal: 2,
          id: "build",
          dependsOn: ["design"],
          agentTargetId: null
        }
      ]
    });
  });

  it.each([
    ["pending", "pending", true],
    ["accepted", "accepted", false],
    ["rejected", "rejected", false],
    ["canceled", "canceled", false],
    ["superseded", "expired", false]
  ] as const)(
    "maps checkpoint status %s to panel state %s",
    (checkpointStatus, panelState, actionable) => {
      const snapshot = configurationSnapshot();
      snapshot.checkpoints[0] = {
        ...snapshot.checkpoints[0]!,
        status: checkpointStatus
      };

      expect(projectTuttiModePlanPanel(snapshot)).toMatchObject({
        state: panelState,
        actionable
      });
    }
  );

  it("uses the newest checkpoint for the current immutable revision", () => {
    const snapshot = configurationSnapshot();
    snapshot.checkpoints.push({
      ...snapshot.checkpoints[0]!,
      id: "checkpoint-2",
      status: "rejected",
      decisionReason: "Revise the budget",
      updatedAtUnixMs: 150
    });

    expect(projectTuttiModePlanPanel(snapshot)).toMatchObject({
      id: "workflow-1:checkpoint-2",
      state: "rejected",
      checkpoint: {
        id: "checkpoint-2",
        decisionReason: "Revise the budget"
      }
    });
  });

  it("fails closed when the current revision or its matching review is missing", () => {
    const missingRevision = configurationSnapshot();
    missingRevision.workflow.currentRevisionId = "revision-missing";
    expect(projectTuttiModePlanPanel(missingRevision)).toBeNull();

    const missingCheckpoint = configurationSnapshot();
    missingCheckpoint.checkpoints = [];
    expect(projectTuttiModePlanPanel(missingCheckpoint)).toBeNull();
  });

  it("fails closed when durable checkpoint kind and parsed Markdown phase disagree", () => {
    const snapshot = configurationSnapshot();
    snapshot.checkpoints[0] = {
      ...snapshot.checkpoints[0]!,
      kind: "task_review"
    };

    expect(projectTuttiModePlanPanel(snapshot)).toBeNull();
  });

  it("does not derive a panel from transcript markers or agent interactions", () => {
    const nonTuttiSnapshot = {
      ...configurationSnapshot(),
      workflow: {
        ...configurationSnapshot().workflow,
        type: "provider_plan"
      },
      transcript: "<!-- legacy-provider-plan -->",
      pendingInteractions: [{ kind: "exit_plan" }]
    } as unknown as TuttiModePlanReviewSnapshot;

    expect(projectTuttiModePlanPanel(nonTuttiSnapshot)).toBeNull();
  });

  it("does not expose mutable arrays from the source snapshot", () => {
    const snapshot = configurationSnapshot();
    const panel = projectTuttiModePlanPanel(snapshot);
    expect(panel).not.toBeNull();

    panel?.tasks.push({
      ordinal: 1,
      id: "local-only",
      title: "Local only",
      content: "",
      priority: "low",
      agentTargetId: null,
      modelPlanId: null,
      model: null,
      executionDirectory: null,
      dependsOn: []
    });

    expect(snapshot.revisions[0]?.document.tasks).toEqual([]);
  });
});
