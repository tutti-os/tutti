import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  TuttiModePlanPanelLabels,
  TuttiModePlanPanelViewModel,
  TuttiPlanIssuePanelLabels,
  TuttiPlanIssueSnapshot
} from "../../workspaceWorkflow";
import {
  TuttiWorkflowDock,
  type TuttiWorkflowDockLabels,
  type TuttiWorkflowDockPhase
} from "./TuttiWorkflowDock";

const labels: TuttiWorkflowDockLabels = {
  cancel: "Cancel plan",
  collapse: "Collapse workflow",
  errorTitle: "Workflow unavailable",
  expand: "Expand workflow",
  issueDone: (done, total) => `${done}/${total} done`,
  issueFailed: (count) => `${count} failed`,
  issuePendingAcceptance: (count) => `${count} awaiting acceptance`,
  issueRunning: (count) => `${count} running`,
  materializingHint: "Turning the accepted plan into tasks",
  materializingTitle: "Creating tasks",
  retry: "Try again",
  switchToSelfReview: "Switch to self review",
  switchingToSelfReview: "Switching",
  selfReviewEnabled: "Self review enabled",
  selfReviewFailed: "Couldn't enable self review",
  reviewHint: "Send to accept",
  reviewHintReplan: "Send to re-plan",
  reviewTitle: "Plan review"
};

const planPanelLabels: TuttiModePlanPanelLabels = {
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
  autoAccept: "Auto-accept",
  notSpecified: "Not specified",
  assignmentOptionsLoading: "Loading options..."
};

const planIssuePanelLabels: TuttiPlanIssuePanelLabels = {
  openIssue: "Open Issue",
  listView: "List",
  boardView: "Board",
  parallelizable: "Parallel",
  autoAccept: "Auto-accept",
  accept: "Accept",
  rework: "Rework",
  dependencies: "Depends",
  stageParallel: (index, count) => `Stage ${index} · parallel ×${count}`,
  stageSequential: (index) => `Stage ${index} · sequential`,
  summary: (done, total, running) =>
    `${done}/${total} done · ${running} running`,
  statusNotStarted: "Todo",
  statusRunning: "Running",
  statusPendingAcceptance: "In review",
  statusCompleted: "Done",
  statusFailed: "Failed",
  statusCanceled: "Canceled"
};

const preferencePopoverLabels = {
  title: "Tutti preferences",
  effectLabel: "Effect",
  speedLabel: "Speed",
  previewHint: "Derived from the request and Skills.",
  previewCost: "Economical",
  previewBalance: "Balanced",
  previewPowerful: "Powerful",
  modelPreferenceLabel: "Model choice",
  modelPreferenceCost: "Economical",
  modelPreferenceBalance: "Balanced",
  modelPreferencePowerful: "Most capable",
  parallelismLabel: "Parallel target",
  parallelismValue: (count: number) =>
    count === 1 ? "1 agent" : `Up to ${count} agents`
};

const plan: TuttiModePlanPanelViewModel = {
  id: "workflow-1:checkpoint-1",
  workflowId: "workflow-1",
  workspaceId: "workspace-1",
  sourceSessionId: "session-1",
  sourceTurnId: "turn-1",
  sourceToolCallId: "tool-1",
  reviewKind: "task_review",
  state: "pending",
  actionable: true,
  title: "Ship the workflow",
  topicId: "topic-1",
  markdownBody: "## Goal\n\nShip safely.",
  revision: {
    id: "revision-1",
    sequence: 1,
    schemaVersion: "tutti-mode-plan/v1",
    documentPath: "plan.md",
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
  tasks: []
};

const issue: TuttiPlanIssueSnapshot = {
  workflowId: "workflow-1",
  sourceTurnId: "turn-1",
  issueId: "issue-1",
  topicId: "topic-1",
  title: "Ship the workflow",
  dispatchPaused: false,
  tasks: [
    {
      taskId: "task-1",
      title: "Build",
      content: "Implement the workflow",
      status: "running",
      sortIndex: 1,
      parallelizable: false,
      autoAccept: false,
      dependencyTaskIds: []
    }
  ]
};

const assignmentCatalog = {
  agents: [],
  optionsByAgentId: {},
  loadAgentOptions: vi.fn()
};

function renderDock(phase: TuttiWorkflowDockPhase) {
  const actions = {
    onAssignmentDraftChange: vi.fn(),
    onCancelReview: vi.fn(),
    onEffectChange: vi.fn(),
    onSpeedChange: vi.fn(),
    onOpenTask: vi.fn(),
    onRetry: vi.fn()
  };
  const view = render(
    <TuttiWorkflowDock
      assignmentCatalog={assignmentCatalog}
      assignmentDrafts={{}}
      preferencePopoverLabels={preferencePopoverLabels}
      labels={labels}
      phase={phase}
      planPanelLabels={planPanelLabels}
      planIssuePanelLabels={planIssuePanelLabels}
      {...actions}
    />
  );
  return { ...view, actions };
}

describe("TuttiWorkflowDock", () => {
  it("offers an explicit audited self-review fallback when independent review fails", async () => {
    const onSwitchToSelfReview = vi.fn(async () => {});
    render(
      <TuttiWorkflowDock
        assignmentCatalog={assignmentCatalog}
        assignmentDrafts={{}}
        preferencePopoverLabels={preferencePopoverLabels}
        labels={labels}
        phase={{
          auditId: "audit-review-1",
          kind: "reviewFailure",
          message: "Independent review failed"
        }}
        planPanelLabels={planPanelLabels}
        planIssuePanelLabels={planIssuePanelLabels}
        onAssignmentDraftChange={vi.fn()}
        onCancelReview={vi.fn()}
        onEffectChange={vi.fn()}
        onSpeedChange={vi.fn()}
        onRetry={vi.fn()}
        onSwitchToSelfReview={onSwitchToSelfReview}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to self review" })
    );
    expect(onSwitchToSelfReview).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Self review enabled")).toBeInTheDocument();
    expect(
      screen.getByText(/Independent review failed · audit-review-1/)
    ).toBeInTheDocument();
  });

  it("starts a newly actionable review expanded and carries it across phases", () => {
    const { actions, rerender } = renderDock({
      kind: "review",
      panel: plan,
      submitting: false,
      effect: 70,
      speed: 60,
      preferencesDiverged: false
    });

    expect(
      screen.getByTestId("agent-gui-tutti-workflow-dock")
    ).toHaveTextContent("Plan review");
    expect(
      screen.getByRole("button", { name: "Collapse workflow" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tutti-mode-plan-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel plan" }));
    expect(actions.onCancelReview).toHaveBeenCalledTimes(1);

    rerender(
      <TuttiWorkflowDock
        assignmentCatalog={assignmentCatalog}
        assignmentDrafts={{}}
        preferencePopoverLabels={preferencePopoverLabels}
        labels={labels}
        phase={{ kind: "materializing", title: "Ship the workflow" }}
        planPanelLabels={planPanelLabels}
        planIssuePanelLabels={planIssuePanelLabels}
        {...actions}
      />
    );
    expect(
      screen.getByRole("button", { name: "Collapse workflow" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText("Turning the accepted plan into tasks")
    ).toBeInTheDocument();

    rerender(
      <TuttiWorkflowDock
        assignmentCatalog={assignmentCatalog}
        assignmentDrafts={{}}
        preferencePopoverLabels={preferencePopoverLabels}
        labels={labels}
        phase={{ kind: "execution", issue }}
        planPanelLabels={planPanelLabels}
        planIssuePanelLabels={planIssuePanelLabels}
        {...actions}
      />
    );
    expect(screen.getByTestId("tutti-plan-issue-panel")).toBeInTheDocument();
    expect(screen.getAllByText(/1 running/).length).toBeGreaterThan(0);
  });

  it("preserves an explicit collapse until a different review becomes actionable", () => {
    const { actions, rerender } = renderDock({
      kind: "review",
      panel: plan,
      submitting: false,
      effect: 70,
      speed: 60,
      preferencesDiverged: false
    });

    fireEvent.click(screen.getByRole("button", { name: "Collapse workflow" }));
    expect(
      screen.getByRole("button", { name: "Expand workflow" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByTestId("tutti-mode-plan-panel")
    ).not.toBeInTheDocument();

    rerender(
      <TuttiWorkflowDock
        assignmentCatalog={assignmentCatalog}
        assignmentDrafts={{}}
        preferencePopoverLabels={preferencePopoverLabels}
        labels={labels}
        phase={{
          kind: "review",
          panel: {
            ...plan,
            title: "Ship the updated workflow",
            revision: {
              ...plan.revision,
              sha256: "b".repeat(64)
            }
          },
          submitting: false,
          effect: 70,
          speed: 60,
          preferencesDiverged: false
        }}
        planPanelLabels={planPanelLabels}
        planIssuePanelLabels={planIssuePanelLabels}
        {...actions}
      />
    );
    expect(
      screen.getByRole("button", { name: "Expand workflow" })
    ).toHaveAttribute("aria-expanded", "false");

    rerender(
      <TuttiWorkflowDock
        assignmentCatalog={assignmentCatalog}
        assignmentDrafts={{}}
        preferencePopoverLabels={preferencePopoverLabels}
        labels={labels}
        phase={{ kind: "materializing", title: "Ship the updated workflow" }}
        planPanelLabels={planPanelLabels}
        planIssuePanelLabels={planIssuePanelLabels}
        {...actions}
      />
    );
    expect(
      screen.getByRole("button", { name: "Expand workflow" })
    ).toHaveAttribute("aria-expanded", "false");

    rerender(
      <TuttiWorkflowDock
        assignmentCatalog={assignmentCatalog}
        assignmentDrafts={{}}
        preferencePopoverLabels={preferencePopoverLabels}
        labels={labels}
        phase={{ kind: "execution", issue }}
        planPanelLabels={planPanelLabels}
        planIssuePanelLabels={planIssuePanelLabels}
        {...actions}
      />
    );
    expect(
      screen.getByRole("button", { name: "Expand workflow" })
    ).toHaveAttribute("aria-expanded", "false");

    const replan = {
      ...plan,
      id: "workflow-1:checkpoint-2",
      title: "Re-plan the workflow",
      checkpoint: {
        ...plan.checkpoint,
        id: "checkpoint-2",
        createdAtUnixMs: 210,
        updatedAtUnixMs: 210
      }
    };
    rerender(
      <TuttiWorkflowDock
        assignmentCatalog={assignmentCatalog}
        assignmentDrafts={{}}
        preferencePopoverLabels={preferencePopoverLabels}
        labels={labels}
        phase={{
          kind: "review",
          panel: replan,
          submitting: false,
          effect: 70,
          speed: 60,
          preferencesDiverged: false
        }}
        planPanelLabels={planPanelLabels}
        planIssuePanelLabels={planIssuePanelLabels}
        {...actions}
      />
    );
    expect(
      screen.getByRole("button", { name: "Collapse workflow" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tutti-mode-plan-panel")).toHaveTextContent(
      "Re-plan the workflow"
    );
  });

  it("changes the review hint without creating a duplicate decision surface", () => {
    renderDock({
      kind: "review",
      panel: plan,
      submitting: false,
      effect: 80,
      speed: 90,
      preferencesDiverged: true
    });

    expect(
      screen.getByTestId("agent-gui-tutti-workflow-dock")
    ).toHaveTextContent("Ship the workflow · Send to re-plan");
    expect(
      screen.getByTestId("agent-gui-tutti-workflow-intensity")
    ).toHaveTextContent("80 · 90");
    expect(
      screen.queryByRole("button", { name: "Send to re-plan" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send to accept" })
    ).not.toBeInTheDocument();
  });
});
