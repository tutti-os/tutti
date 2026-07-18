import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTuttiModePlanPanels } from "./useTuttiModePlanPanels";
import {
  TuttiModePlanReviewRuntimeProvider,
  type TuttiModePlanReviewRuntime,
  type TuttiPlanIssueQueryResult,
  type TuttiPlanIssueSnapshot,
  type TuttiPlanIssueSource
} from "../workspaceWorkflowRuntime";

function snapshotFor(sessionId: string): TuttiPlanIssueSnapshot {
  return {
    workflowId: `workflow-${sessionId}`,
    sourceTurnId: `turn-${sessionId}`,
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
  resolve: (result: TuttiPlanIssueQueryResult) => void;
}

function createHarness(): {
  runtime: TuttiModePlanReviewRuntime;
  loads: DeferredLoad[];
  emitIssueUpdate: (issueId: string) => void;
  emitWorkflowUpdate: (sourceSessionId: string) => void;
} {
  const loads: DeferredLoad[] = [];
  const listeners = new Set<(update: { issueId: string }) => void>();
  const workflowListeners = new Set<
    Parameters<TuttiModePlanReviewRuntime["subscribe"]>[1]
  >();
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
    subscribe: (_workspaceId, listener) => {
      workflowListeners.add(listener);
      return () => workflowListeners.delete(listener);
    },
    planIssues: source
  };
  return {
    runtime,
    loads,
    emitIssueUpdate: (issueId) => {
      for (const listener of listeners) listener({ issueId });
    },
    emitWorkflowUpdate: (sourceSessionId) => {
      for (const listener of workflowListeners) {
        listener({
          kind: "workflow_updated",
          workspaceId: "workspace-1",
          workflowId: "workflow-1",
          sourceSessionId,
          checkpointId: "checkpoint-1",
          changeKind: "operation_updated"
        });
      }
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
      load.resolve({ kind: "issue", issue: snapshotFor(load.sessionId) });
    }
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent(
        "tutti-mode-plan-session-a"
      )
    );
  });

  it("re-reads the plan issue on workflow updates for this session", async () => {
    // workspace.issue.updated fires during materialization, before the
    // create_issue operation records its outcome; the workflow's
    // operation_updated event is the authoritative post-completion signal.
    // Without this re-read, an accepted plan's issue panel stays invisible
    // until a remount.
    const harness = createHarness();
    render(
      <TuttiModePlanReviewRuntimeProvider runtime={harness.runtime}>
        <Probe sessionId="session-a" />
      </TuttiModePlanReviewRuntimeProvider>
    );
    await waitFor(() => expect(harness.loads.length).toBe(1));
    harness.loads[0]!.resolve(null);
    harness.emitWorkflowUpdate("session-a");
    await waitFor(() => expect(harness.loads.length).toBe(2));
    harness.loads[1]!.resolve({
      kind: "issue",
      issue: snapshotFor("session-a")
    });
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent(
        "tutti-mode-plan-session-a"
      )
    );

    // Another session's workflow event must not trigger a read for this one.
    harness.emitWorkflowUpdate("session-b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.loads.length).toBe(2);
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
      load.resolve({ kind: "issue", issue: snapshotFor(load.sessionId) });
    }
    await waitFor(() =>
      expect(
        harness.loads.filter((load) => load.sessionId === "session-b").length
      ).toBeGreaterThan(0)
    );
    for (const load of harness.loads.filter(
      (load) => load.sessionId === "session-b"
    )) {
      load.resolve({ kind: "issue", issue: snapshotFor(load.sessionId) });
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
      load.resolve({ kind: "issue", issue: snapshotFor(load.sessionId) });
    }
    await waitFor(() =>
      expect(screen.getByTestId("probe")).toHaveTextContent(
        "tutti-mode-plan-session-a"
      )
    );
  });
});
