import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TuttiModePlanPanel,
  type TuttiModePlanPanelLabels
} from "./TuttiModePlanPanel";
import type { TuttiModePlanPanelViewModel } from "./tuttiModePlanPanelProjection";

const labels: TuttiModePlanPanelLabels = {
  mode: "Tutti mode plan",
  configurationReview: "Configuration review",
  taskReview: "Task review",
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
  budgetAuto: "Automatic",
  budgetFixed: "Fixed",
  reasoningIntensity: "Reasoning intensity",
  orchestrationIntensity: "Orchestration intensity",
  tokenLimit: "Token limit",
  quotaWaterline: "Quota waterline",
  taskId: "Task ID",
  priority: "Priority",
  priorityHigh: "High",
  priorityMedium: "Medium",
  priorityLow: "Low",
  agentTarget: "Agent target",
  modelPlan: "Model plan",
  model: "Model",
  executionDirectory: "Execution directory",
  dependencies: "Dependencies",
  notSpecified: "Not specified",
  none: "None"
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
      executionDirectory: "/workspace/implement",
      dependsOn: ["foundation", "contract-tests"]
    }
  ]
};

describe("TuttiModePlanPanel", () => {
  it("localizes execution and budget enum values", () => {
    render(
      <TuttiModePlanPanel
        labels={labels}
        panel={panel}
        submitting={false}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Sequential")).toBeInTheDocument();
    expect(screen.getByText(/Fixed/)).toBeInTheDocument();
    expect(screen.queryByText("sequential")).not.toBeInTheDocument();
  });

  it("shows every materialization input before acceptance", () => {
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
    expect(screen.getByText("Token limit")).toBeInTheDocument();
    expect(screen.getByText("12,000")).toBeInTheDocument();
    expect(screen.getByText("Quota waterline")).toBeInTheDocument();
    expect(screen.getByText("15%")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getAllByText("High")).toHaveLength(2);
    expect(screen.getByText("codex-agent")).toBeInTheDocument();
    expect(screen.getByText("model-plan-pro")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-sol")).toBeInTheDocument();
    expect(screen.getByText("/workspace/implement")).toBeInTheDocument();
    expect(screen.getByText("foundation")).toBeInTheDocument();
    expect(screen.getByText("contract-tests")).toBeInTheDocument();
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
        reason: undefined
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
        reason: "Split implementation from verification"
      })
    );
  });
});
