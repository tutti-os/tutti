import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  TuttiModePlanPanelViewModel,
  TuttiPlanIssueMaterializationFailure,
  TuttiPlanIssueSnapshot
} from "../../../workspaceWorkflow";
import { buildAgentComposerDraft } from "../model/agentComposerDraft";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "../AgentGUINodeView";
import { useAgentGUITuttiWorkflow } from "./useAgentGUITuttiWorkflow";

const mocks = vi.hoisted(() => ({
  useTuttiModePlanPanels: vi.fn()
}));

vi.mock("../../../workspaceWorkflow", async () => {
  const actual = await vi.importActual<
    typeof import("../../../workspaceWorkflow")
  >("../../../workspaceWorkflow");
  return {
    ...actual,
    useTuttiModePlanPanels: mocks.useTuttiModePlanPanels
  };
});

interface PlanPanelsProjection {
  error: unknown;
  panels: readonly TuttiModePlanPanelViewModel[];
  planIssue: TuttiPlanIssueSnapshot | null;
  planIssueMaterializationFailure: TuttiPlanIssueMaterializationFailure | null;
  submittingCheckpointId: string | null;
}

const decide = vi.fn().mockResolvedValue(undefined);

function panel(
  checkpointId = "checkpoint-a",
  workflowId = "workflow-a"
): TuttiModePlanPanelViewModel {
  return {
    id: `${workflowId}:${checkpointId}`,
    workflowId,
    workspaceId: "workspace-1",
    sourceSessionId: "session-a",
    sourceTurnId: "turn-a",
    sourceToolCallId: "tool-a",
    reviewKind: "task_review",
    state: "pending",
    actionable: true,
    title: "Ship safely",
    topicId: "topic-1",
    markdownBody: "## Plan",
    revision: {
      id: "revision-a",
      sequence: 1,
      schemaVersion: "tutti-mode-plan/v1",
      documentPath: "tutti-mode-plans/workflow-a/revision.md",
      sha256: "a".repeat(64),
      producedByTurnId: "turn-a",
      createdAtUnixMs: 1
    },
    checkpoint: {
      id: checkpointId,
      status: "pending",
      decidedBy: null,
      decisionReason: null,
      decidedAtUnixMs: null,
      createdAtUnixMs: 2,
      updatedAtUnixMs: 2
    },
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
  };
}

function issue(workflowId = "workflow-a"): TuttiPlanIssueSnapshot {
  return {
    workflowId,
    sourceTurnId: "turn-a",
    issueId: "issue-a",
    topicId: "topic-1",
    title: "Ship safely",
    tasks: []
  };
}

function failure(
  workflowId = "workflow-a"
): TuttiPlanIssueMaterializationFailure {
  return {
    workflowId,
    sourceTurnId: "turn-a",
    errorMessage: "Issue creation failed"
  };
}

function viewModel(activeConversationId: string): AgentGUINodeViewModel {
  return {
    shell: {
      workspaceId: "workspace-1",
      currentUserId: "user-1"
    },
    rail: { activeConversationId },
    composer: {
      draftContent: buildAgentComposerDraft({ prompt: "" }),
      tuttiModeOrchestrationIntensity: 50
    }
  } as unknown as AgentGUINodeViewModel;
}

const labels = {
  tuttiModePlanIssueCreateFailed: (message: string) => message,
  tuttiModePlanLoadFailed: "Plan load failed",
  tuttiModePlanReplanFeedback: () => "Re-plan",
  tuttiModePlanReplanFeedbackSuffix: () => " Re-plan"
} as unknown as AgentGUIViewLabels;

function renderWorkflow(initial: PlanPanelsProjection) {
  let projection = initial;
  mocks.useTuttiModePlanPanels.mockImplementation(() => ({
    assignmentCatalog: {
      agents: [],
      optionsByAgentId: {},
      loadAgentOptions: vi.fn()
    },
    decide,
    decidePlanIssueTask: null,
    cancelPlanIssueExecution: null,
    resolvePlanIssueTaskSession: null,
    retry: vi.fn(),
    loading: false,
    ...projection
  }));
  const rendered = renderHook(
    ({ activeConversationId }: { activeConversationId: string }) =>
      useAgentGUITuttiWorkflow({
        viewModel: viewModel(activeConversationId),
        labels,
        stableLinkAction: undefined,
        setTuttiModeActive: vi.fn(),
        setTuttiModeOrchestrationIntensity: vi.fn(),
        updateDraftContent: vi.fn(),
        submitPromptPassthrough: vi.fn()
      }),
    { initialProps: { activeConversationId: "session-a" } }
  );
  return {
    ...rendered,
    setProjection(next: PlanPanelsProjection): void {
      projection = next;
    }
  };
}

function reviewProjection(review = panel()): PlanPanelsProjection {
  return {
    error: null,
    panels: [review],
    planIssue: null,
    planIssueMaterializationFailure: null,
    submittingCheckpointId: null
  };
}

function emptyProjection(): PlanPanelsProjection {
  return {
    error: null,
    panels: [],
    planIssue: null,
    planIssueMaterializationFailure: null,
    submittingCheckpointId: null
  };
}

describe("useAgentGUITuttiWorkflow materialization bridge", () => {
  it("does not restore materializing after the matching Issue arrived", async () => {
    const rendered = renderWorkflow(reviewProjection());

    act(() => rendered.result.current.composer.acceptPendingPlan());
    rendered.setProjection(emptyProjection());
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase?.kind).toBe(
      "materializing"
    );

    rendered.setProjection({
      ...emptyProjection(),
      planIssue: issue()
    });
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase?.kind).toBe("execution");
    await waitFor(() => expect(decide).toHaveBeenCalled());

    rendered.setProjection(emptyProjection());
    rendered.rerender({ activeConversationId: "session-b" });
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase).toBeNull();
  });

  it("clears materializing after the matching failure arrives", async () => {
    const rendered = renderWorkflow(reviewProjection());

    act(() => rendered.result.current.composer.acceptPendingPlan());
    rendered.setProjection({
      ...emptyProjection(),
      planIssueMaterializationFailure: failure()
    });
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase?.kind).toBe("error");
    await waitFor(() =>
      expect(rendered.result.current.workflowDock.phase?.kind).toBe("error")
    );

    rendered.setProjection(emptyProjection());
    rendered.rerender({ activeConversationId: "session-b" });
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase).toBeNull();
  });

  it("clears materializing when the accept decision fails", async () => {
    const rendered = renderWorkflow(reviewProjection());

    act(() => rendered.result.current.composer.acceptPendingPlan());
    rendered.setProjection({
      ...reviewProjection(),
      error: new Error("Decision failed")
    });
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase?.kind).toBe("review");
    await waitFor(() =>
      expect(rendered.result.current.workflowDock.phase?.kind).toBe("review")
    );

    rendered.setProjection(emptyProjection());
    rendered.rerender({ activeConversationId: "session-b" });
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase).toBeNull();
  });

  it("clears materializing when a newer checkpoint supersedes it", async () => {
    const rendered = renderWorkflow(reviewProjection());

    act(() => rendered.result.current.composer.acceptPendingPlan());
    rendered.setProjection(reviewProjection(panel("checkpoint-a2")));
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase?.kind).toBe("review");
    await waitFor(() =>
      expect(rendered.result.current.workflowDock.phase?.kind).toBe("review")
    );

    rendered.setProjection(emptyProjection());
    rendered.rerender({ activeConversationId: "session-b" });
    rendered.rerender({ activeConversationId: "session-a" });
    expect(rendered.result.current.workflowDock.phase).toBeNull();
  });
});
