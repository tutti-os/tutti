import { act, renderHook, waitFor } from "@testing-library/react";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type {
  AgentComposerDraft,
  AgentGUIOptimisticGoalControl
} from "../model/agentGuiNodeTypes";
import { agentComposerDraftPrompt } from "../model/agentComposerDraft";
import {
  clearSubmittedAgentGUIHomeDraft,
  restoreFailedAgentGUIHomeDraft
} from "./agentGuiController.homeDraftHelpers";
import { useAgentGUISubmitInteractionActions } from "./useAgentGUISubmitInteractionActions";

const draftKey = "node-default:codex:local:codex";

function draft(prompt: string): AgentComposerDraft {
  return [{ type: "text", text: prompt }];
}

function createGoalControlInput(
  goalControl: AgentActivityRuntime["goalControl"]
) {
  const sessionEngine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: { execute: async () => undefined },
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: { schedule: () => ({ cancel() {} }) }
  });
  const setDetailError = vi.fn();
  const setGoalClearNoticeSequence = vi.fn();
  const optimisticGoalControlRef = {
    current: null as AgentGUIOptimisticGoalControl | null
  };
  const setOptimisticGoalControl = vi.fn(
    (
      update:
        | AgentGUIOptimisticGoalControl
        | null
        | ((
            current: AgentGUIOptimisticGoalControl | null
          ) => AgentGUIOptimisticGoalControl | null)
    ) => {
      optimisticGoalControlRef.current =
        typeof update === "function"
          ? update(optimisticGoalControlRef.current)
          : update;
    }
  );
  const draftByScopeKeyRef = {
    current: {} as Record<string, AgentComposerDraft>
  };
  const setDraftByScopeKey = vi.fn(
    (
      update:
        | Record<string, AgentComposerDraft>
        | ((
            current: Record<string, AgentComposerDraft>
          ) => Record<string, AgentComposerDraft>)
    ) => {
      draftByScopeKeyRef.current =
        typeof update === "function"
          ? update(draftByScopeKeyRef.current)
          : update;
    }
  );
  const input = {
    activation: {
      activate: vi.fn(),
      codeFor: vi.fn(() => null),
      errorFor: vi.fn(() => null)
    },
    activeConversationIdRef: { current: "session-1" },
    activeEngineActiveTurn: null,
    activeEnginePendingInteractions: [],
    agentActivityRuntime: { goalControl } as AgentActivityRuntime,
    conversationListQuery: {},
    conversationsRef: { current: [] },
    dataRef: { current: {} },
    draftByScopeKeyRef,
    executePromptRef: { current: vi.fn() },
    isComposerHomeRef: { current: false },
    isCurrentConversation: (agentSessionId: string) =>
      agentSessionId === "session-1",
    isRespondingToInteraction: false,
    isSessionMarkedNonResumable: () => false,
    persistActiveConversation: vi.fn(),
    planActionsRef: {
      current: { implement: vi.fn(), feedback: vi.fn(), skip: vi.fn() }
    },
    previewMode: false,
    promptImagesSupported: true,
    optimisticGoalControl: null,
    sessionEngine,
    setActiveConversationId: vi.fn(),
    setDetailError,
    setDraftByScopeKey,
    setGoalClearNoticeSequence,
    setIntent: vi.fn(),
    setOptimisticGoalControl,
    submittedDraftSnapshotsRef: { current: {} },
    startConversation: vi.fn(() => null),
    submitPromptRef: { current: vi.fn() },
    transientConversation: null,
    workspaceId: "workspace-1"
  } as unknown as Parameters<typeof useAgentGUISubmitInteractionActions>[0];
  return {
    input,
    draftByScopeKeyRef,
    optimisticGoalControlRef,
    sessionEngine,
    setDetailError,
    setDraftByScopeKey,
    setGoalClearNoticeSequence,
    setOptimisticGoalControl
  };
}

describe("new-conversation home draft lifecycle", () => {
  it("clears only the draft that still matches the submitted content", () => {
    const submitted = draft("first");
    const matching = { [draftKey]: draft("first") };
    const changed = { [draftKey]: draft("second") };

    expect(
      agentComposerDraftPrompt(
        clearSubmittedAgentGUIHomeDraft({
          draftKey,
          drafts: matching,
          submittedDraft: submitted
        })[draftKey]!
      )
    ).toBe("");
    expect(
      clearSubmittedAgentGUIHomeDraft({
        draftKey,
        drafts: changed,
        submittedDraft: submitted
      })
    ).toBe(changed);
  });

  it("restores a failed activation only when the home draft is still empty", () => {
    const empty = { [draftKey]: draft("") };
    const changed = { [draftKey]: draft("second") };
    const failure = {
      draftKey,
      submittedDraft: draft("first")
    };

    expect(
      agentComposerDraftPrompt(
        restoreFailedAgentGUIHomeDraft({ ...failure, drafts: empty })[draftKey]!
      )
    ).toBe("first");
    expect(
      restoreFailedAgentGUIHomeDraft({ ...failure, drafts: changed })
    ).toBe(changed);
  });
});

describe("conversation stop", () => {
  it("dispatches one unified stop intent for activation and active-turn states", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine } = createGoalControlInput(
      goalControl as never
    );
    const dispatch = vi.spyOn(sessionEngine, "dispatch");
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() => result.current.interruptCurrentTurn("not running"));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        type: "session/stopRequested",
        workspaceId: "workspace-1"
      })
    );
  });
});

describe("goal controls", () => {
  it("publishes an optimistic goal before the control API settles", async () => {
    const goalControl = vi.fn(() => new Promise<void>(() => {}));
    const { input, optimisticGoalControlRef } = createGoalControlInput(
      goalControl as never
    );
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt([
        { type: "text", text: "/goal count to ten" }
      ])
    );

    expect(optimisticGoalControlRef.current).toMatchObject({
      agentSessionId: "session-1",
      goal: { objective: "count to ten", status: "active" },
      reconcileOnObjectiveMatch: false
    });
    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
  });

  it("publishes a new-session goal as soon as activation starts", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, optimisticGoalControlRef } = createGoalControlInput(
      goalControl as never
    );
    input.activeConversationIdRef.current = null;
    input.isComposerHomeRef.current = true;
    input.startConversation = vi.fn(() => ({
      agentSessionId: "session-new",
      requestId: "activation-1"
    }));
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt([
        { type: "text", text: "/goal count to ten" }
      ])
    );

    expect(input.startConversation).toHaveBeenCalledWith(
      [{ type: "text", text: "/goal count to ten" }],
      undefined,
      undefined,
      false,
      { action: "set", objective: "count to ten" }
    );
    expect(optimisticGoalControlRef.current).toEqual({
      agentSessionId: "session-new",
      goal: { objective: "count to ten", status: "active" },
      reconcileOnObjectiveMatch: true,
      requestId: "goal-activation:activation-1"
    });
    expect(goalControl).not.toHaveBeenCalled();
  });

  it("clears a submitted goal draft after the control API accepts it", async () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, draftByScopeKeyRef, sessionEngine, setDraftByScopeKey } =
      createGoalControlInput(goalControl as never);
    const sessionDraftKey = "session:session-1";
    draftByScopeKeyRef.current = {
      [sessionDraftKey]: draft("/goal count to ten")
    };
    const dispatch = vi.spyOn(sessionEngine, "dispatch");
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt([
        { type: "text", text: "/goal count to ten" }
      ])
    );

    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        agentComposerDraftPrompt(draftByScopeKeyRef.current[sessionDraftKey]!)
      ).toBe("")
    );
    expect(setDraftByScopeKey).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves a newer draft edit while a goal control request is pending", async () => {
    let acceptGoalControl: (() => void) | null = null;
    const goalControl = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acceptGoalControl = resolve;
        })
    );
    const { input, draftByScopeKeyRef } = createGoalControlInput(
      goalControl as never
    );
    const sessionDraftKey = "session:session-1";
    draftByScopeKeyRef.current = {
      [sessionDraftKey]: draft("/goal count to ten")
    };
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt([
        { type: "text", text: "/goal count to ten" }
      ])
    );
    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
    draftByScopeKeyRef.current = {
      [sessionDraftKey]: draft("new message")
    };
    await act(async () => acceptGoalControl?.());

    expect(
      agentComposerDraftPrompt(draftByScopeKeyRef.current[sessionDraftKey]!)
    ).toBe("new message");
  });

  it("keeps the submitted goal draft when the control API rejects it", async () => {
    const goalControl = vi.fn(async () =>
      Promise.reject(new Error("goal failed"))
    );
    const {
      input,
      draftByScopeKeyRef,
      optimisticGoalControlRef,
      setDetailError,
      setDraftByScopeKey
    } = createGoalControlInput(goalControl as never);
    const sessionDraftKey = "session:session-1";
    draftByScopeKeyRef.current = {
      [sessionDraftKey]: draft("/goal count to ten")
    };
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt([
        { type: "text", text: "/goal count to ten" }
      ])
    );

    await waitFor(() =>
      expect(setDetailError).toHaveBeenCalledWith("goal failed")
    );
    expect(
      agentComposerDraftPrompt(draftByScopeKeyRef.current[sessionDraftKey]!)
    ).toBe("/goal count to ten");
    expect(setDraftByScopeKey).not.toHaveBeenCalled();
    expect(optimisticGoalControlRef.current).toBeNull();
  });

  it("clears through the control API without creating a prompt submit", async () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine, setGoalClearNoticeSequence } =
      createGoalControlInput(goalControl as never);
    const dispatch = vi.spyOn(sessionEngine, "dispatch");
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() => result.current.goalControl("clear"));

    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
    expect(goalControl).toHaveBeenCalledWith({
      action: "clear",
      agentSessionId: "session-1",
      clientSubmitId: expect.stringMatching(/^goal-control:/),
      workspaceId: "workspace-1"
    });
    expect(setGoalClearNoticeSequence).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports a clear failure without showing a success toast", async () => {
    const error = new Error("clear failed");
    const goalControl = vi.fn(async () => Promise.reject(error));
    const { input, setDetailError, setGoalClearNoticeSequence } =
      createGoalControlInput(goalControl as never);
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() => result.current.goalControl("clear"));

    await waitFor(() =>
      expect(setDetailError).toHaveBeenCalledWith("clear failed")
    );
    expect(setGoalClearNoticeSequence).not.toHaveBeenCalled();
  });
});
