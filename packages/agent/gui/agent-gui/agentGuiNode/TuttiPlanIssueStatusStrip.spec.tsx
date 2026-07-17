import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TuttiPlanIssueStatusStrip,
  type TuttiPlanIssueStatusStripLabels
} from "./TuttiPlanIssueStatusStrip";

const labels: TuttiPlanIssueStatusStripLabels = {
  running: (count) => `${count} subtasks running`,
  pendingAcceptance: (count) => `${count} awaiting acceptance`,
  failed: (count) => `${count} failed`,
  done: (done, total) => `${done}/${total} done`,
  jump: "View the subtask board"
};

describe("TuttiPlanIssueStatusStrip", () => {
  it("summarizes live counts and omits zero segments", () => {
    render(
      <TuttiPlanIssueStatusStrip
        title="Forest duo game"
        counts={{
          running: 2,
          pendingAcceptance: 1,
          failed: 0,
          done: 1,
          total: 4
        }}
        labels={labels}
        onJump={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("agent-gui-tutti-plan-issue-strip-summary")
    ).toHaveTextContent(
      "2 subtasks running · 1 awaiting acceptance · 1/4 done"
    );
    expect(screen.getByText("Forest duo game")).toBeInTheDocument();
    // Live work shows the spinner in place of the static list icon.
    expect(
      screen.getByTestId("agent-gui-tutti-plan-issue-strip-spinner")
    ).toBeInTheDocument();
  });

  it("always keeps the done anchor even when nothing is live", () => {
    render(
      <TuttiPlanIssueStatusStrip
        title="Forest duo game"
        counts={{
          running: 0,
          pendingAcceptance: 0,
          failed: 0,
          done: 4,
          total: 4
        }}
        labels={labels}
        onJump={vi.fn()}
      />
    );
    expect(
      screen.getByTestId("agent-gui-tutti-plan-issue-strip-summary")
    ).toHaveTextContent("4/4 done");
    expect(
      screen.queryByTestId("agent-gui-tutti-plan-issue-strip-spinner")
    ).not.toBeInTheDocument();
  });

  it("jumps to the embedded panel on click", () => {
    const onJump = vi.fn();
    render(
      <TuttiPlanIssueStatusStrip
        title="Forest duo game"
        counts={{
          running: 1,
          pendingAcceptance: 0,
          failed: 1,
          done: 0,
          total: 2
        }}
        labels={labels}
        onJump={onJump}
      />
    );
    fireEvent.click(screen.getByTestId("agent-gui-tutti-plan-issue-strip"));
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});
