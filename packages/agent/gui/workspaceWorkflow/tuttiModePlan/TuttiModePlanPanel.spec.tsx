import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TuttiModePlanPanel,
  type TuttiModePlanPanelLabels
} from "./TuttiModePlanPanel";
import type { TuttiModePlanPanelViewModel } from "./tuttiModePlanPanelProjection";
import type { TuttiModePlanAssignmentCatalog } from "./useTuttiModePlanPanels";

const labels: TuttiModePlanPanelLabels = {
  mode: "Tutti mode plan",
  taskReview: "Plan review",
  pending: "Needs review",
  tasks: "Tasks",
  priority: "Priority",
  priorityHigh: "High",
  priorityMedium: "Medium",
  priorityLow: "Low",
  agentTarget: "Agent",
  model: "Model",
  permissionMode: "Permission mode",
  reasoningEffort: "Reasoning effort",
  parallelizable: "Parallel",
  notSpecified: "Not specified",
  assignmentOptionsLoading: "Loading options..."
};

const panel: TuttiModePlanPanelViewModel = {
  id: "workflow-1:checkpoint-1",
  workflowId: "workflow-1",
  workspaceId: "workspace-1",
  sourceSessionId: "session-1",
  sourceTurnId: "turn-1",
  sourceToolCallId: "tool-call-1",
  reviewKind: "task_review",
  state: "pending",
  actionable: true,
  title: "Ship the durable workflow",
  topicId: "topic-1",
  markdownBody: "## Goal\n\nShip safely.",
  revision: {
    id: "revision-1",
    sequence: 1,
    schemaVersion: "tutti-mode-plan/v1",
    documentPath: `tutti-mode-plans/workflow-1/revisions/${"a".repeat(64)}.md`,
    sha256: "a".repeat(64),
    producedByTurnId: "turn-1",
    createdAtUnixMs: 100
  },
  checkpoint: {
    id: "checkpoint-1",
    status: "pending",
    decidedBy: null,
    decisionReason: null,
    decidedAtUnixMs: null,
    createdAtUnixMs: 110,
    updatedAtUnixMs: 110
  },
  execution: {
    mode: "sequential",
    reasoningIntensity: 70,
    orchestrationIntensity: 60
  },
  budget: {
    mode: "fixed",
    tokenLimit: 12_000,
    quotaWaterlinePercent: 15
  },
  tasks: [
    {
      ordinal: 1,
      id: "implement",
      title: "Implement",
      content: "Build the workflow",
      priority: "high",
      agentTargetId: "codex-agent",
      modelPlanId: "model-plan-pro",
      model: "gpt-5.6-sol",
      permissionModeId: "acceptEdits",
      reasoningEffort: "high",
      executionDirectory: "/workspace/implement",
      dependsOn: ["foundation", "contract-tests"],
      parallelizable: true
    }
  ]
};

function assignmentCatalog(
  overrides: Partial<TuttiModePlanAssignmentCatalog> = {}
): TuttiModePlanAssignmentCatalog {
  return {
    agents: [
      { agentTargetId: "codex-agent", label: "Codex" },
      { agentTargetId: "claude-agent", label: "Claude Code" }
    ],
    optionsByAgentId: {
      "codex-agent": {
        models: ["gpt-5.6-sol"],
        modelPlans: [
          {
            modelPlanId: "model-plan-pro",
            label: "Pro plan",
            models: ["gpt-5.6-sol"]
          }
        ],
        permissionModes: [{ id: "acceptEdits", label: "Accept edits" }],
        reasoningEfforts: ["low", "high"]
      }
    },
    loadAgentOptions: vi.fn(),
    ...overrides
  };
}

describe("TuttiModePlanPanel", () => {
  it("hides plan internals: execution/budget cards, task metadata, decisions", () => {
    render(
      <TuttiModePlanPanel labels={labels} panel={panel} submitting={false} />
    );

    // Execution / budget tuning happens by re-planning, not on the card.
    expect(screen.queryByText("Execution")).not.toBeInTheDocument();
    expect(screen.queryByText("Budget")).not.toBeInTheDocument();
    expect(screen.queryByText("Sequential")).not.toBeInTheDocument();
    expect(screen.queryByText("Quota waterline")).not.toBeInTheDocument();
    expect(screen.queryByText("15%")).not.toBeInTheDocument();
    // Task ID / execution directory / dependencies stay out of the card.
    expect(screen.queryByText("/workspace/implement")).not.toBeInTheDocument();
    expect(screen.queryByText("foundation")).not.toBeInTheDocument();
    // Decisions live in the composer now — no footer buttons.
    expect(
      screen.queryByRole("button", { name: "Accept" })
    ).not.toBeInTheDocument();
  });

  it("shows specified assignments read-only without an assignment catalog", () => {
    render(
      <TuttiModePlanPanel labels={labels} panel={panel} submitting={false} />
    );

    expect(screen.getByText("codex-agent")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("acceptEdits")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("Parallel")).toBeInTheDocument();
    // Model plans never surface on tasks — plans enter via agent config.
    expect(screen.queryByText("model-plan-pro")).not.toBeInTheDocument();
  });

  it("renders per-task assignment selectors without a model plan select", () => {
    render(
      <TuttiModePlanPanel
        assignmentCatalog={assignmentCatalog()}
        assignmentDrafts={{}}
        labels={labels}
        panel={panel}
        submitting={false}
        onAssignmentDraftChange={vi.fn()}
      />
    );

    expect(
      screen.getByTestId("tutti-plan-task-assignment-implement")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Permission mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Reasoning effort")).toBeInTheDocument();
    expect(screen.queryByLabelText("Model plan")).not.toBeInTheDocument();
    // The parallel opt-in renders as a pressed toggle seeded from the plan.
    expect(
      screen.getByTestId("tutti-plan-task-parallel-toggle-implement")
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("stays read-only without a host-owned draft store", () => {
    render(
      <TuttiModePlanPanel
        assignmentCatalog={assignmentCatalog()}
        labels={labels}
        panel={panel}
        submitting={false}
      />
    );

    expect(
      screen.queryByTestId("tutti-plan-task-assignment-implement")
    ).not.toBeInTheDocument();
  });

  it("stays read-only for non-actionable panels even with a catalog", () => {
    render(
      <TuttiModePlanPanel
        assignmentCatalog={assignmentCatalog()}
        assignmentDrafts={{}}
        labels={labels}
        panel={{ ...panel, state: "accepted", actionable: false }}
        submitting={false}
        onAssignmentDraftChange={vi.fn()}
      />
    );

    expect(
      screen.queryByTestId("tutti-plan-task-assignment-implement")
    ).not.toBeInTheDocument();
  });
});
