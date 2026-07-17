import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  accept: "Accept",
  requestChanges: "Request changes",
  cancel: "Cancel plan",
  feedbackPlaceholder: "Describe what should change",
  submitFeedback: "Send feedback",
  feedbackRequired: "Add feedback before requesting changes",
  tasks: "Tasks",
  execution: "Execution",
  executionSequential: "Sequential",
  executionParallel: "Parallel",
  budget: "Budget",
  reasoningIntensity: "Reasoning intensity",
  orchestrationIntensity: "Orchestration intensity",
  quotaWaterline: "Quota waterline",
  taskId: "Task ID",
  priority: "Priority",
  priorityHigh: "High",
  priorityMedium: "Medium",
  priorityLow: "Low",
  agentTarget: "Agent",
  modelPlan: "Model plan",
  model: "Model",
  permissionMode: "Permission mode",
  reasoningEffort: "Reasoning effort",
  executionDirectory: "Execution directory",
  dependencies: "Dependencies",
  notSpecified: "Not specified",
  none: "None",
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
      dependsOn: ["foundation", "contract-tests"]
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
  it("localizes execution enum values and hides the retired token limit", () => {
    render(
      <TuttiModePlanPanel
        labels={labels}
        panel={panel}
        submitting={false}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Sequential")).toBeInTheDocument();
    expect(screen.queryByText("sequential")).not.toBeInTheDocument();
    expect(screen.queryByText("Token limit")).not.toBeInTheDocument();
    expect(screen.queryByText("12,000")).not.toBeInTheDocument();
    expect(screen.getByText("Quota waterline")).toBeInTheDocument();
    expect(screen.getByText("15%")).toBeInTheDocument();
  });

  it("shows every materialization input read-only without an assignment catalog", () => {
    render(
      <TuttiModePlanPanel
        labels={labels}
        panel={panel}
        submitting={false}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Reasoning intensity")).toBeInTheDocument();
    expect(screen.getByText("70 / 100")).toBeInTheDocument();
    expect(screen.getByText("Orchestration intensity")).toBeInTheDocument();
    expect(screen.getByText("60 / 100")).toBeInTheDocument();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(screen.getByText("codex-agent")).toBeInTheDocument();
    expect(screen.getByText("model-plan-pro")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("acceptEdits")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("/workspace/implement")).toBeInTheDocument();
    expect(screen.getByText("foundation")).toBeInTheDocument();
    expect(screen.getByText("contract-tests")).toBeInTheDocument();
  });

  it("renders per-task assignment selectors when the catalog is loaded", () => {
    render(
      <TuttiModePlanPanel
        assignmentCatalog={assignmentCatalog()}
        labels={labels}
        panel={panel}
        submitting={false}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.getByTestId("tutti-plan-task-assignment-implement")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("Model plan")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.getByLabelText("Permission mode")).toBeInTheDocument();
    expect(screen.getByLabelText("Reasoning effort")).toBeInTheDocument();
  });

  it("stays read-only for non-actionable panels even with a catalog", () => {
    render(
      <TuttiModePlanPanel
        assignmentCatalog={assignmentCatalog()}
        labels={labels}
        panel={{ ...panel, state: "accepted", actionable: false }}
        submitting={false}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.queryByTestId("tutti-plan-task-assignment-implement")
    ).not.toBeInTheDocument();
  });

  it("submits acceptance against the durable checkpoint identity", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(
      <TuttiModePlanPanel
        labels={labels}
        panel={panel}
        submitting={false}
        onDecide={onDecide}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({
        workflowId: "workflow-1",
        checkpointId: "checkpoint-1",
        decision: "accepted",
        reason: undefined,
        taskAssignments: undefined
      })
    );
  });

  it("requires explicit feedback before rejecting a plan", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(
      <TuttiModePlanPanel
        labels={labels}
        panel={panel}
        submitting={false}
        onDecide={onDecide}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Add feedback before requesting changes"
    );
    expect(onDecide).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByPlaceholderText("Describe what should change"),
      { target: { value: "Split implementation from verification" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() =>
      expect(onDecide).toHaveBeenCalledWith({
        workflowId: "workflow-1",
        checkpointId: "checkpoint-1",
        decision: "rejected",
        reason: "Split implementation from verification",
        taskAssignments: undefined
      })
    );
  });
});
