import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  TuttiModePlanPanelViewModel,
  TuttiPlanIssueMaterializationFailure,
  TuttiPlanIssueSnapshot
} from "../../../workspaceWorkflow";
import {
  agentComposerDraftPrompt,
  buildAgentComposerDraft
} from "../model/agentComposerDraft";
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

function issue(
  workflowId = "workflow-a",
  options: { dispatchPaused?: boolean; taskStatus?: string } = {}
): TuttiPlanIssueSnapshot {
  return {
    workflowId,
    sourceTurnId: "turn-a",
    issueId: "issue-a",
    topicId: "topic-1",
    title: "Ship safely",
    dispatchPaused: options.dispatchPaused ?? false,
    tasks: options.taskStatus
      ? [
          {
            taskId: "task-a",
            title: "Build",
            content: "",
            status: options.taskStatus,
            sortIndex: 1,
            parallelizable: false,
            autoAccept: false,
            dependencyTaskIds: []
          }
        ]
      : []
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

function viewModel(
  activeConversationId: string,
  options: {
    activeTurn?: boolean;
    activeTurnGuidance?: boolean;
    tuttiModeActive?: boolean;
  } = {}
): AgentGUINodeViewModel {
  return {
    shell: {
      workspaceId: "workspace-1",
      currentUserId: "user-1"
    },
    rail: { activeConversationId },
    detail: {
      conversationDetail: {
        session: {
          activeTurn: options.activeTurn
            ? { turnId: "turn-active", phase: "running" }
            : null,
          capabilities: {
            activeTurnGuidance: options.activeTurnGuidance === true
          }
        }
      }
    },
    composer: {
      draftContent: buildAgentComposerDraft({ prompt: "" }),
      isTuttiModeActive: options.tuttiModeActive ?? true,
      tuttiModeEffect: 50,
      tuttiModeSpeed: 50
    }
  } as unknown as AgentGUINodeViewModel;
}

const labels = {
  tuttiModePlanIssueAcceptPrompt: (reference: string) => `Accept ${reference}`,
  tuttiModePlanIssueCreateFailed: (message: string) => message,
  tuttiModePlanIssueReworkPrompt: (reference: string) => `Rework ${reference}`,
  tuttiModePlanLoadFailed: "Plan load failed",
  tuttiModePlanReplanFeedback: () => "Re-plan",
  tuttiModePlanReplanFeedbackSuffix: () => " Re-plan"
} as unknown as AgentGUIViewLabels;

function renderWorkflow(
  initial: PlanPanelsProjection,
  options: {
    activeTurn?: boolean;
    activeTurnGuidance?: boolean;
    tuttiModeActive?: boolean;
    cancelPlanIssueExecution?: (() => Promise<void>) | null;
  } = {}
) {
  let projection = initial;
  const submitPromptPassthrough = vi.fn();
  const updateDraftContent = vi.fn();
  mocks.useTuttiModePlanPanels.mockImplementation(() => ({
    assignmentCatalog: {
      agents: [],
      optionsByAgentId: {},
      loadAgentOptions: vi.fn()
    },
    decide,
    cancelPlanIssueExecution: options.cancelPlanIssueExecution ?? null,
    resolvePlanIssueTaskSession: null,
    retry: vi.fn(),
    loading: false,
    ...projection
  }));
  const rendered = renderHook(
    ({ activeConversationId }: { activeConversationId: string }) =>
      useAgentGUITuttiWorkflow({
        viewModel: viewModel(activeConversationId, options),
        labels,
        stableLinkAction: undefined,
        setTuttiModeActive: vi.fn(),
        setTuttiModeEffect: vi.fn(),
        setTuttiModeSpeed: vi.fn(),
        updateDraftContent,
        submitPromptPassthrough
      }),
    { initialProps: { activeConversationId: "session-a" } }
  );
  return {
    ...rendered,
    submitPromptPassthrough,
    updateDraftContent,
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
  it("uses the legacy intensity as effect only when preference snapshots are absent", () => {
    const legacyPanel = panel();
    legacyPanel.execution = {
      ...legacyPanel.execution,
      orchestrationIntensity: 73
    };
    const legacy = renderWorkflow(reviewProjection(legacyPanel));
    expect(legacy.result.current.composer.planReviewPreferencesDiverged).toBe(
      true
    );
    legacy.unmount();

    const currentPanel = panel();
    currentPanel.execution = {
      ...currentPanel.execution,
      effect: 50,
      speed: 50,
      orchestrationIntensity: 73
    };
    const current = renderWorkflow(reviewProjection(currentPanel));
    expect(current.result.current.composer.planReviewPreferencesDiverged).toBe(
      false
    );
  });

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

describe("useAgentGUITuttiWorkflow execution composer", () => {
  const executionProjection = (): PlanPanelsProjection => ({
    ...emptyProjection(),
    planIssue: issue("workflow-a", { taskStatus: "running" })
  });

  it.each([
    {
      content: "Adjust the approach",
      name: "ordinary text"
    },
    {
      content: "/compact",
      name: "compact command"
    },
    {
      content: "/goal clear",
      name: "Goal control command"
    }
  ])(
    "uses an ordinary submit for $name during active execution",
    ({ content }) => {
      const rendered = renderWorkflow(executionProjection(), {
        activeTurn: true,
        activeTurnGuidance: true
      });

      act(() =>
        rendered.result.current.composer.submitPromptOrDecidePlan([
          { type: "text", text: content }
        ])
      );

      expect(rendered.submitPromptPassthrough).toHaveBeenCalledWith([
        { type: "text", text: content }
      ]);
    }
  );

  it.each([
    ["accept", "Accept"],
    ["rework", "Rework"]
  ] as const)(
    "prefills the source composer for a task %s action",
    async (action, prefix) => {
      const rendered = renderWorkflow(executionProjection());

      await act(async () => {
        await rendered.result.current.workflowDock.taskAction?.(
          "task-a",
          action
        );
      });

      expect(rendered.updateDraftContent).toHaveBeenCalledTimes(1);
      const draft = rendered.updateDraftContent.mock.calls[0]?.[0];
      expect(agentComposerDraftPrompt(draft)).toContain(
        `${prefix} [Build](mention://workspace-issue/issue-a?workspaceId=workspace-1&topicId=topic-1&taskId=task-a)`
      );
    }
  );

  it("owns one in-flight durable execution stop", async () => {
    let settle: (() => void) | undefined;
    const cancelPlanIssueExecution = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    const rendered = renderWorkflow(executionProjection(), {
      cancelPlanIssueExecution
    });

    let firstStop!: Promise<void>;
    act(() => {
      firstStop = rendered.result.current.composer.stopTuttiExecution();
      void rendered.result.current.composer.stopTuttiExecution();
    });

    expect(cancelPlanIssueExecution).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.composer.tuttiExecutionStopping).toBe(true);
    settle?.();
    await act(async () => firstStop);
    expect(rendered.result.current.composer.tuttiExecutionStopping).toBe(false);
  });
});

describe("useAgentGUITuttiWorkflow Tutti Mode dock gate", () => {
  const executionProjection = (): PlanPanelsProjection => ({
    ...emptyProjection(),
    planIssue: issue("workflow-a", { taskStatus: "running" })
  });

  it("hides the dock while Tutti Mode is off despite a live plan Issue", () => {
    const off = renderWorkflow(executionProjection(), {
      tuttiModeActive: false
    });
    expect(off.result.current.workflowDock.phase).toBeNull();
    off.unmount();

    const on = renderWorkflow(executionProjection(), { tuttiModeActive: true });
    expect(on.result.current.workflowDock.phase?.kind).toBe("execution");
  });

  it("hides a pending plan review while Tutti Mode is off", () => {
    const rendered = renderWorkflow(reviewProjection(), {
      tuttiModeActive: false
    });
    expect(rendered.result.current.workflowDock.phase).toBeNull();
  });
});
