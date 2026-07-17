import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTuttiPlanIssuePanel } from "./useTuttiPlanIssuePanel";
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
  const { issue } = useTuttiPlanIssuePanel({
    workspaceId: "workspace-1",
    sourceSessionId: sessionId
  });
  return <div data-testid="probe">{issue ? issue.issueId : "none"}</div>;
}

describe("useTuttiPlanIssuePanel", () => {
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

    // The rail settles on a different conversation before the first load
    // resolves — the exact sequence observed in the desktop logs.
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
    // A load for the new scope must have been issued at all.
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
