import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
      dependencyTaskIds: []
    },
    {
      taskId: "p2",
      title: "Core gameplay",
      content: "WASD",
      status: "running",
      sortIndex: 2,
      parallelizable: true,
      dependencyTaskIds: []
    },
    {
      taskId: "s3",
      title: "Polish and ship",
      content: "QA",
      status: "not_started",
      sortIndex: 3,
      parallelizable: false,
      dependencyTaskIds: ["p1", "p2"]
    }
  ]
};

describe("groupTuttiPlanIssueTasksIntoStages", () => {
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
});
