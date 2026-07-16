import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentActivityRuntimeProvider,
  resetAgentActivityRuntimeForTests,
  type AgentActivityRuntime
} from "../../../agentActivityRuntime";
import type { AgentCollaborationVM } from "../contracts/agentCollaborationVM";
import { AgentCollaborationRow } from "./AgentCollaborationRow";

afterEach(() => {
  cleanup();
  resetAgentActivityRuntimeForTests();
  vi.restoreAllMocks();
});

function collaboration(
  overrides: Partial<AgentCollaborationVM> = {}
): AgentCollaborationVM {
  return {
    adoption: "pending",
    attempt: 1,
    agentSessionId: "source-session",
    contextScope: "summary",
    durationMs: null,
    cost: null,
    failureReason: null,
    failureStage: null,
    kind: "collaboration",
    mode: "delegate",
    model: "gpt-5.6",
    modelPlanId: "plan-1",
    modelPlanName: "Ultra",
    resultText: null,
    retryOfRunId: null,
    requestText: "Review the implementation.",
    runId: "run-1",
    status: "running",
    targetAgentTargetId: "workspace-agent:reviewer",
    targetSessionId: "target-session",
    triggerReason: "user dispatch",
    triggerSource: "user",
    usage: null,
    workspaceId: "workspace-1",
    ...overrides
  };
}

describe("AgentCollaborationRow cancellation", () => {
  it("cancels a running durable collaboration through the host runtime", async () => {
    const cancelCollaboration = vi
      .fn()
      .mockResolvedValue({ status: "canceled" });
    const runtime = {
      cancelCollaboration
    } as unknown as AgentActivityRuntime;

    render(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <AgentCollaborationRow
          basePath="/workspace"
          collaboration={collaboration()}
          workspaceRoot="/workspace"
        />
      </AgentActivityRuntimeProvider>
    );

    fireEvent.click(screen.getByTestId("agent-collaboration-cancel"));
    await waitFor(() => {
      expect(cancelCollaboration).toHaveBeenCalledWith({
        runId: "run-1",
        workspaceId: "workspace-1"
      });
    });
  });

  it("hides cancel for settled and preview cards", () => {
    const runtime = {
      cancelCollaboration: vi.fn()
    } as unknown as AgentActivityRuntime;
    const view = render(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <AgentCollaborationRow
          basePath="/workspace"
          collaboration={collaboration({ status: "completed" })}
          workspaceRoot="/workspace"
        />
      </AgentActivityRuntimeProvider>
    );
    expect(
      screen.queryByTestId("agent-collaboration-cancel")
    ).not.toBeInTheDocument();

    view.rerender(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <AgentCollaborationRow
          basePath="/workspace"
          collaboration={collaboration()}
          previewMode
          workspaceRoot="/workspace"
        />
      </AgentActivityRuntimeProvider>
    );
    expect(
      screen.queryByTestId("agent-collaboration-cancel")
    ).not.toBeInTheDocument();
  });
});

describe("AgentCollaborationRow failure recovery", () => {
  it("shows durable accounting and retries a failed run", async () => {
    const retryCollaboration = vi.fn().mockResolvedValue({
      id: "run-2",
      status: "running"
    });
    const runtime = {
      retryCollaboration,
      setCollaborationAdoption: vi.fn().mockResolvedValue({
        adoption: "rejected"
      })
    } as unknown as AgentActivityRuntime;

    render(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <AgentCollaborationRow
          basePath="/workspace"
          collaboration={collaboration({
            attempt: 2,
            cost: { currency: "USD", estimatedMicros: 125_000 },
            failureReason: "provider unavailable",
            failureStage: "target_execution",
            retryOfRunId: "run-0",
            status: "failed",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 60,
              cacheWriteTokens: 10
            }
          })}
          workspaceRoot="/workspace"
        />
      </AgentActivityRuntimeProvider>
    );

    expect(screen.getByTestId("agent-collaboration-attempt")).toHaveTextContent(
      "2"
    );
    expect(screen.getByTestId("agent-collaboration-cost")).toHaveTextContent(
      "0.125"
    );
    expect(screen.getByTestId("agent-collaboration-usage")).toHaveTextContent(
      "100"
    );
    expect(screen.getByTestId("agent-collaboration-usage")).toHaveTextContent(
      "60"
    );
    expect(screen.getByTestId("agent-collaboration-usage")).toHaveTextContent(
      "10"
    );
    expect(
      screen.getByTestId("agent-collaboration-failure-stage")
    ).toHaveTextContent("target_execution");

    fireEvent.click(screen.getByTestId("agent-collaboration-retry"));
    await waitFor(() => {
      expect(retryCollaboration).toHaveBeenCalledWith({
        runId: "run-1",
        workspaceId: "workspace-1"
      });
    });
  });

  it("returns the original request for a different model or Agent", () => {
    const onReviseCollaboration = vi.fn();

    render(
      <AgentCollaborationRow
        basePath="/workspace"
        collaboration={collaboration({
          failureReason: "provider unavailable",
          status: "failed"
        })}
        onReviseCollaboration={onReviseCollaboration}
        workspaceRoot="/workspace"
      />
    );

    fireEvent.click(screen.getByTestId("agent-collaboration-revise"));
    expect(onReviseCollaboration).toHaveBeenCalledWith(
      expect.objectContaining({
        requestText: "Review the implementation.",
        runId: "run-1"
      })
    );
  });
});
