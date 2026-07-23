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
  reviewHint: "Send to accept",
  reviewHintReplan: "Send to re-plan",
  reviewTitle: "Plan review"
};

const planPanelLabels: TuttiModePlanPanelLabels = {
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
  autoAccept: "Auto-accept",
  notSpecified: "Not specified",
  assignmentOptionsLoading: "Loading options..."
};

const planIssuePanelLabels: TuttiPlanIssuePanelLabels = {
  openIssue: "Open Issue",
  stopExecution: "Stop",
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

const intensityPopoverLabels = {
  title: "Tutti intensity",
  intensityLabel: "Intensity",
  previewTitle: "Planner tendency",
  previewHint: "Derived from the request and Skills.",
  previewCost: "Cost",
  previewBalance: "Balance",
  previewPowerful: "Powerful",
  modelStrengthLabel: "Model strength",
  modelStrengthCost: "Economical",
  modelStrengthBalance: "Balanced",
  modelStrengthPowerful: "Most capable",
  agentCountLabel: "Parallel Agents",
  agentCountCost: "1",
  agentCountBalance: "2–3",
  agentCountPowerful: "Up to 4",
  confirm: "Confirm",
  cancel: "Cancel"
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
    onIntensityChange: vi.fn(),
    onOpenTask: vi.fn(),
    onRetry: vi.fn()
  };
  const view = render(
    <TuttiWorkflowDock
      assignmentCatalog={assignmentCatalog}
      assignmentDrafts={{}}
      intensityPopoverLabels={intensityPopoverLabels}
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
  it("starts a newly actionable review expanded and carries it across phases", () => {
    const { actions, rerender } = renderDock({
      kind: "review",
      panel: plan,
      submitting: false,
      intensity: 60,
      intensityDiverged: false
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
        intensityPopoverLabels={intensityPopoverLabels}
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
        intensityPopoverLabels={intensityPopoverLabels}
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
      intensity: 60,
      intensityDiverged: false
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
        intensityPopoverLabels={intensityPopoverLabels}
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
          intensity: 60,
          intensityDiverged: false
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
        intensityPopoverLabels={intensityPopoverLabels}
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
        intensityPopoverLabels={intensityPopoverLabels}
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
        intensityPopoverLabels={intensityPopoverLabels}
        labels={labels}
        phase={{
          kind: "review",
          panel: replan,
          submitting: false,
          intensity: 60,
          intensityDiverged: false
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

  it("changes the review hint when intensity diverges", () => {
    renderDock({
      kind: "review",
      panel: plan,
      submitting: false,
      intensity: 80,
      intensityDiverged: true
    });

    expect(
      screen.getByTestId("agent-gui-tutti-workflow-dock")
    ).toHaveTextContent("Ship the workflow · Send to re-plan");
    expect(
      screen.getByTestId("agent-gui-tutti-workflow-intensity")
    ).toHaveTextContent("80");
  });
});
