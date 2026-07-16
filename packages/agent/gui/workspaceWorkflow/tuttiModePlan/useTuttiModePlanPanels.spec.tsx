import { act, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  TuttiModePlanReviewRuntimeProvider,
  type TuttiModePlanReviewRuntime
} from "../workspaceWorkflowRuntime";
import type { TuttiModePlanReviewSnapshot } from "./tuttiModePlanPanelProjection";
import { useTuttiModePlanPanels } from "./useTuttiModePlanPanels";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function snapshot(sourceSessionId: string): TuttiModePlanReviewSnapshot {
  const suffix = sourceSessionId.replace("session-", "");
  const workflowId = `workflow-${suffix}`;
  const revisionId = `revision-${suffix}`;
  return {
    workflow: {
      id: workflowId,
      workspaceId: "workspace-1",
      type: "tutti_mode_plan",
      owner: "tutti",
      triggerKind: "agent_cli",
      sourceSessionId,
      status: "pending_review",
      currentRevisionId: revisionId
    },
    revisions: [
      {
        id: revisionId,
        workflowId,
        sequence: 1,
        schemaVersion: "tutti-mode-plan/v1",
        documentPath: `tutti-mode-plans/${workflowId}/revisions/${"a".repeat(64)}.md`,
        sha256: "a".repeat(64),
        createdAtUnixMs: 100,
        document: {
          schema: "tutti-mode-plan/v1",
          phase: "configuration",
          title: `Plan ${suffix}`,
          topicId: "topic-1",
          markdownBody: "## Goal\n\nShip safely",
          execution: {
            mode: "sequential",
            reasoningIntensity: 50,
            orchestrationIntensity: 50
          },
          budget: {
            mode: "auto",
            tokenLimit: 80_000,
            quotaWaterlinePercent: 10
          },
          tasks: []
        }
      }
    ],
    checkpoints: [
      {
        id: `checkpoint-${suffix}`,
        workflowId,
        kind: "configuration_review",
        revisionId,
        status: "pending",
        createdAtUnixMs: 110,
        updatedAtUnixMs: 110
      }
    ]
  };
}

function renderPanels(runtime: TuttiModePlanReviewRuntime) {
  return renderHook(
    ({ sourceSessionId }: { sourceSessionId: string | null }) =>
      useTuttiModePlanPanels({
        decidedBy: "user-1",
        sourceSessionId,
        workspaceId: "workspace-1"
      }),
    {
      initialProps: { sourceSessionId: "session-a" as string | null },
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          <TuttiModePlanReviewRuntimeProvider runtime={runtime}>
            {children}
          </TuttiModePlanReviewRuntimeProvider>
        </StrictMode>
      )
    }
  );
}

describe("useTuttiModePlanPanels", () => {
  it("keeps disabled preview scopes transport-free", async () => {
    const runtime: TuttiModePlanReviewRuntime = {
      listPending: vi.fn(() => Promise.resolve([snapshot("session-a")])),
      decide: vi.fn(),
      subscribe: vi.fn(() => () => undefined)
    };
    const rendered = renderHook(
      () =>
        useTuttiModePlanPanels({
          decidedBy: "user-1",
          enabled: false,
          sourceSessionId: "session-a",
          workspaceId: "workspace-1"
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <StrictMode>
            <TuttiModePlanReviewRuntimeProvider runtime={runtime}>
              {children}
            </TuttiModePlanReviewRuntimeProvider>
          </StrictMode>
        )
      }
    );

    await act(async () => undefined);

    expect(runtime.listPending).not.toHaveBeenCalled();
    expect(runtime.subscribe).not.toHaveBeenCalled();
    expect(rendered.result.current.panels).toEqual([]);
  });

  it("clears session A panels immediately when switching to session B", async () => {
    const sessionB = deferred<readonly TuttiModePlanReviewSnapshot[]>();
    const runtime: TuttiModePlanReviewRuntime = {
      listPending: vi.fn(({ sourceSessionId }) =>
        sourceSessionId === "session-a"
          ? Promise.resolve([snapshot("session-a")])
          : sessionB.promise
      ),
      decide: vi.fn(),
      subscribe: vi.fn(() => () => undefined)
    };
    const rendered = renderPanels(runtime);
    await act(async () => undefined);
    expect(rendered.result.current.panels[0]?.sourceSessionId).toBe(
      "session-a"
    );

    rendered.rerender({ sourceSessionId: "session-b" });

    expect(rendered.result.current.panels).toEqual([]);
  });

  it("ignores session A results across an empty scope before session B", async () => {
    const sessionA = deferred<readonly TuttiModePlanReviewSnapshot[]>();
    const sessionB = deferred<readonly TuttiModePlanReviewSnapshot[]>();
    const runtime: TuttiModePlanReviewRuntime = {
      listPending: vi.fn(({ sourceSessionId }) =>
        sourceSessionId === "session-a" ? sessionA.promise : sessionB.promise
      ),
      decide: vi.fn(),
      subscribe: vi.fn(() => () => undefined)
    };
    const rendered = renderPanels(runtime);
    rendered.rerender({ sourceSessionId: null });
    rendered.rerender({ sourceSessionId: "session-b" });

    await act(async () => sessionA.resolve([snapshot("session-a")]));
    expect(rendered.result.current.panels).toEqual([]);

    await act(async () => sessionB.resolve([snapshot("session-b")]));
    expect(rendered.result.current.panels[0]?.sourceSessionId).toBe(
      "session-b"
    );
  });

  it("does not let an in-flight session A decision mutate session B state", async () => {
    const decision = deferred<void>();
    const runtime: TuttiModePlanReviewRuntime = {
      listPending: vi.fn(({ sourceSessionId }) =>
        Promise.resolve([snapshot(sourceSessionId)])
      ),
      decide: vi.fn(() => decision.promise),
      subscribe: vi.fn(() => () => undefined)
    };
    const rendered = renderPanels(runtime);
    await act(async () => undefined);
    let decisionPromise!: Promise<void>;
    act(() => {
      decisionPromise = rendered.result.current.decide({
        checkpointId: "checkpoint-a",
        decision: "accepted",
        workflowId: "workflow-a"
      });
    });
    expect(rendered.result.current.submittingCheckpointId).toBe("checkpoint-a");

    rendered.rerender({ sourceSessionId: "session-b" });
    await act(async () => undefined);
    expect(rendered.result.current.panels[0]?.sourceSessionId).toBe(
      "session-b"
    );
    expect(rendered.result.current.submittingCheckpointId).toBeNull();

    await act(async () => decision.resolve());
    await decisionPromise;
    expect(rendered.result.current.panels[0]?.sourceSessionId).toBe(
      "session-b"
    );
    expect(rendered.result.current.submittingCheckpointId).toBeNull();
  });

  it("reconciles the active scope after reconnect and ignores the older in-flight result", async () => {
    const beforeReconnect = deferred<readonly TuttiModePlanReviewSnapshot[]>();
    const afterReconnect = deferred<readonly TuttiModePlanReviewSnapshot[]>();
    let reconnected = false;
    let invalidationListener:
      | Parameters<TuttiModePlanReviewRuntime["subscribe"]>[1]
      | undefined;
    const runtime: TuttiModePlanReviewRuntime = {
      listPending: vi.fn(() =>
        reconnected ? afterReconnect.promise : beforeReconnect.promise
      ),
      decide: vi.fn(),
      subscribe: vi.fn((_workspaceId, listener) => {
        invalidationListener = listener;
        return () => undefined;
      })
    };
    const rendered = renderPanels(runtime);
    await act(async () => undefined);

    reconnected = true;
    act(() => {
      invalidationListener?.({
        kind: "connection_restored",
        workspaceId: "workspace-1"
      });
    });

    await act(async () => beforeReconnect.resolve([snapshot("session-a")]));
    expect(rendered.result.current.panels).toEqual([]);

    await act(async () => afterReconnect.resolve([snapshot("session-a")]));
    expect(rendered.result.current.panels[0]?.workflowId).toBe("workflow-a");
    expect(runtime.listPending).toHaveBeenCalledWith({
      sourceSessionId: "session-a",
      workspaceId: "workspace-1"
    });
  });
});
