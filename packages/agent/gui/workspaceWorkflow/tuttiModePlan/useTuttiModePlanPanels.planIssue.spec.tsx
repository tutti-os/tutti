import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTuttiModePlanPanels } from "./useTuttiModePlanPanels";
import {
  TuttiModePlanReviewRuntimeProvider,
  type TuttiModePlanReviewRuntime,
  type TuttiPlanIssueSnapshot,
  type TuttiPlanIssueSource
} from "../workspaceWorkflowRuntime";

function snapshotFor(sessionId: string): TuttiPlanIssueSnapshot {
  return {
    issueId: `tutti-mode-plan-${sessionId}`,
    topicId: "default",
    title: `Issue for ${sessionId}`,
    tasks: [
      {
        taskId: "task-1",
        title: "Only",
        content: "",
        status: "running",
        sortIndex: 1,
        parallelizable: false,
        autoAccept: false,
        dependencyTaskIds: []
      }
    ]
  };
}

interface DeferredLoad {
  sessionId: string;
  resolve: (issue: TuttiPlanIssueSnapshot | null) => void;
}

function createHarness(): {
  runtime: TuttiModePlanReviewRuntime;
  loads: DeferredLoad[];
  emitIssueUpdate: (issueId: string) => void;
} {
  const loads: DeferredLoad[] = [];
  const listeners = new Set<(update: { issueId: string }) => void>();
  const source: TuttiPlanIssueSource = {
    getSessionPlanIssue({ sourceSessionId }) {
      return new Promise((resolve) => {
        loads.push({ sessionId: sourceSessionId, resolve });
      });
    },
    subscribeIssueUpdates(_workspaceId, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acceptTask: vi.fn().mockResolvedValue(undefined),
    rejectTask: vi.fn().mockResolvedValue(undefined)
  };
  const runtime: TuttiModePlanReviewRuntime = {
    listPending: vi.fn().mockResolvedValue([]),
    decide: vi.fn().mockResolvedValue(undefined),
    subscribe: () => () => undefined,
    planIssues: source
  };
  return {
    runtime,
    loads,
    emitIssueUpdate: (issueId) => {
      for (const listener of listeners) listener({ issueId });
    }
  };
}

function Probe({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { planIssue } = useTuttiModePlanPanels({
    decidedBy: "user-1",
    workspaceId: "workspace-1",
    sourceSessionId: sessionId
  });
  return (
    <div data-testid="probe">{planIssue ? planIssue.issueId : "none"}</div>
  );
}

// The plan-issue embed rides the review panels hook lifecycle (one scope, one
// effect); these probes pin the load/refresh semantics the embedded panel
// depends on.
describe("useTuttiModePlanPanels plan issue embed", () => {
  it("surfaces the loaded issue under StrictMode double-mount", async () => {
    const harness = createHarness();
    render(
      <StrictMode>
        <TuttiModePlanReviewRuntimeProvider runtime={harness.runtime}>
          <Probe sessionId="session-a" />
        </TuttiModePlanReviewRuntimeProvider>
      </StrictMode>
    );
    await waitFor(() => expect(harness.loads.length).toBeGreaterThan(0));
    for (const load of [...harness.loads]) {
      load.resolve(snapshotFor(load.sessionId));
    }
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent(
        "tutti-mode-plan-session-a"
      )
    );
  });

  it("loads the new scope when the conversation flips mid-flight", async () => {
    const harness = createHarness();
    const view = render(
      <StrictMode>
        <TuttiModePlanReviewRuntimeProvider runtime={harness.runtime}>
          <Probe sessionId="session-a" />
        </TuttiModePlanReviewRuntimeProvider>
      </StrictMode>
    );
    await waitFor(() => expect(harness.loads.length).toBeGreaterThan(0));
    const pendingA = [...harness.loads];

    view.rerender(
      <StrictMode>
        <TuttiModePlanReviewRuntimeProvider runtime={harness.runtime}>
          <Probe sessionId="session-b" />
        </TuttiModePlanReviewRuntimeProvider>
      </StrictMode>
    );
    // The stale loads resolve late and must be discarded.
    for (const load of pendingA) {
      load.resolve(snapshotFor(load.sessionId));
    }
    await waitFor(() =>
      expect(
        harness.loads.filter((load) => load.sessionId === "session-b").length
      ).toBeGreaterThan(0)
    );
    for (const load of harness.loads.filter(
      (load) => load.sessionId === "session-b"
    )) {
      load.resolve(snapshotFor(load.sessionId));
    }
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent(
        "tutti-mode-plan-session-b"
      )
    );
  });

  it("retries via issue updates after an initially empty load", async () => {
    const harness = createHarness();
    render(
      <StrictMode>
        <TuttiModePlanReviewRuntimeProvider runtime={harness.runtime}>
          <Probe sessionId="session-a" />
        </TuttiModePlanReviewRuntimeProvider>
      </StrictMode>
    );
    await waitFor(() => expect(harness.loads.length).toBeGreaterThan(0));
    for (const load of [...harness.loads]) {
      load.resolve(null);
    }
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent("none")
    );

    const before = harness.loads.length;
    harness.emitIssueUpdate("tutti-mode-plan-session-a");
    await waitFor(() => expect(harness.loads.length).toBeGreaterThan(before));
    for (const load of harness.loads.slice(before)) {
      load.resolve(snapshotFor(load.sessionId));
    }
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent(
        "tutti-mode-plan-session-a"
      )
    );
  });
});
