import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TuttiPlanIssuePanel,
  groupTuttiPlanIssueTasksIntoStages,
  type TuttiPlanIssuePanelLabels
} from "./TuttiPlanIssuePanel";
import type { TuttiPlanIssueSnapshot } from "../workspaceWorkflowRuntime";

const labels: TuttiPlanIssuePanelLabels = {
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

const issue: TuttiPlanIssueSnapshot = {
  issueId: "tutti-mode-plan-wf-1",
  topicId: "default",
  title: "Neon chase MVP",
  tasks: [
    {
      taskId: "p1",
      title: "Build the stage",
      content: "Foundations",
      status: "completed",
      sortIndex: 1,
      parallelizable: true,
      autoAccept: false,
      dependencyTaskIds: []
    },
    {
      taskId: "p2",
      title: "Core gameplay",
      content: "WASD",
      status: "running",
      sortIndex: 2,
      parallelizable: true,
      autoAccept: true,
      dependencyTaskIds: []
    },
    {
      taskId: "s3",
      title: "Polish and ship",
      content: "QA",
      status: "not_started",
      sortIndex: 3,
      parallelizable: false,
      autoAccept: false,
      dependencyTaskIds: ["p1", "p2"]
    }
  ]
};

describe("groupTuttiPlanIssueTasksIntoStages", () => {
  it("splits chained parallelizable tasks into separate stages", () => {
    // A parallelizable task that depends on a member of the running stage can
    // never actually run alongside it, so the display must not pretend it can.
    const chained: TuttiPlanIssueSnapshot["tasks"] = [
      {
        taskId: "c1",
        title: "First",
        content: "",
        status: "not_started",
        sortIndex: 1,
        parallelizable: true,
        autoAccept: false,
        dependencyTaskIds: []
      },
      {
        taskId: "c2",
        title: "Second",
        content: "",
        status: "not_started",
        sortIndex: 2,
        parallelizable: true,
        autoAccept: false,
        dependencyTaskIds: ["c1"]
      },
      {
        taskId: "c3",
        title: "Third",
        content: "",
        status: "not_started",
        sortIndex: 3,
        parallelizable: true,
        autoAccept: false,
        dependencyTaskIds: []
      }
    ];
    const stages = groupTuttiPlanIssueTasksIntoStages(chained);
    expect(
      stages.map((stage) => stage.tasks.map((task) => task.taskId))
    ).toEqual([["c1"], ["c2", "c3"]]);
  });

  it("mirrors dispatcher semantics: parallel batch then exclusive stage", () => {
    const stages = groupTuttiPlanIssueTasksIntoStages(issue.tasks);
    expect(stages.map((stage) => stage.kind)).toEqual([
      "parallel",
      "sequential"
    ]);
    expect(stages[0]?.tasks.map((task) => task.taskId)).toEqual(["p1", "p2"]);
    expect(stages[1]?.tasks.map((task) => task.taskId)).toEqual(["s3"]);
  });
});

describe("TuttiPlanIssuePanel", () => {
  it("defaults to the board with status columns and structure chips", () => {
    render(
      <TuttiPlanIssuePanel
        issue={issue}
        labels={labels}
        onOpenIssue={vi.fn()}
      />
    );

    expect(screen.getByText("Neon chase MVP")).toBeInTheDocument();
    expect(screen.getByText("1/3 done · 1 running")).toBeInTheDocument();
    expect(
      screen.getByTestId("tutti-plan-issue-column-running")
    ).toHaveTextContent("Core gameplay");
    expect(
      screen.getByTestId("tutti-plan-issue-column-completed")
    ).toHaveTextContent("Build the stage");
    // No failed/canceled tasks: those columns stay hidden.
    expect(
      screen.queryByTestId("tutti-plan-issue-column-failed")
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("Parallel").length).toBeGreaterThan(0);
  });

  it("switches to the stage-grouped list view", () => {
    render(
      <TuttiPlanIssuePanel
        issue={issue}
        labels={labels}
        onOpenIssue={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("tutti-plan-issue-view-list"));
    expect(
      screen.getByTestId("tutti-plan-issue-stage-parallel")
    ).toHaveTextContent("Stage 1 · parallel ×2");
    expect(
      screen.getByTestId("tutti-plan-issue-stage-sequential")
    ).toHaveTextContent("Stage 2 · sequential");
    expect(screen.getByText("Depends: p1, p2")).toBeInTheDocument();
  });

  it("jumps to the full issue surface", () => {
    const onOpenIssue = vi.fn();
    render(
      <TuttiPlanIssuePanel
        issue={issue}
        labels={labels}
        onOpenIssue={onOpenIssue}
      />
    );
    fireEvent.click(screen.getByTestId("tutti-plan-issue-open"));
    expect(onOpenIssue).toHaveBeenCalledTimes(1);
  });

  it("shows the auto-accept chip on flagged tasks", () => {
    render(
      <TuttiPlanIssuePanel
        issue={issue}
        labels={labels}
        onOpenIssue={vi.fn()}
      />
    );
    expect(screen.getAllByText("Auto-accept").length).toBeGreaterThan(0);
  });

  it("settles the acceptance gate inline for pending tasks", async () => {
    const pendingIssue: TuttiPlanIssueSnapshot = {
      ...issue,
      tasks: [
        {
          taskId: "gate",
          title: "Review me",
          content: "",
          status: "pending_acceptance",
          sortIndex: 1,
          parallelizable: false,
          autoAccept: false,
          dependencyTaskIds: []
        }
      ]
    };
    const onDecideTask = vi.fn().mockResolvedValue(undefined);
    render(
      <TuttiPlanIssuePanel
        issue={pendingIssue}
        labels={labels}
        onDecideTask={onDecideTask}
      />
    );

    fireEvent.click(screen.getByTestId("tutti-plan-issue-accept-gate"));
    expect(onDecideTask).toHaveBeenCalledWith("gate", "accept");
    // In-flight decision disables both buttons until the promise settles.
    expect(screen.getByTestId("tutti-plan-issue-rework-gate")).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByTestId("tutti-plan-issue-rework-gate")).toBeEnabled()
    );

    fireEvent.click(screen.getByTestId("tutti-plan-issue-rework-gate"));
    expect(onDecideTask).toHaveBeenCalledWith("gate", "rework");
  });

  it("offers only rework on a failed task to re-open dispatch", () => {
    const failedIssue: TuttiPlanIssueSnapshot = {
      ...issue,
      tasks: [
        {
          taskId: "boom",
          title: "Broke",
          content: "",
          status: "failed",
          sortIndex: 1,
          parallelizable: false,
          autoAccept: false,
          dependencyTaskIds: []
        }
      ]
    };
    const onDecideTask = vi.fn().mockResolvedValue(undefined);
    render(
      <TuttiPlanIssuePanel
        issue={failedIssue}
        labels={labels}
        onDecideTask={onDecideTask}
      />
    );
    expect(
      screen.queryByTestId("tutti-plan-issue-accept-boom")
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tutti-plan-issue-rework-boom"));
    expect(onDecideTask).toHaveBeenCalledWith("boom", "rework");
  });

  it("keeps pending tasks display-only without a decision callback", () => {
    const pendingIssue: TuttiPlanIssueSnapshot = {
      ...issue,
      tasks: [
        {
          taskId: "gate",
          title: "Review me",
          content: "",
          status: "pending_acceptance",
          sortIndex: 1,
          parallelizable: false,
          autoAccept: false,
          dependencyTaskIds: []
        }
      ]
    };
    render(<TuttiPlanIssuePanel issue={pendingIssue} labels={labels} />);
    expect(
      screen.queryByTestId("tutti-plan-issue-accept-gate")
    ).not.toBeInTheDocument();
  });
});
