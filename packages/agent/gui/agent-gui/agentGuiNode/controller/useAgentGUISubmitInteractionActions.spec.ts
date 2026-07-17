import { act, renderHook, waitFor } from "@testing-library/react";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
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
    draftByScopeKeyRef: { current: {} },
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
    sessionEngine,
    setActiveConversationId: vi.fn(),
    setDetailError,
    setDraftByScopeKey: vi.fn(),
    setGoalClearNoticeSequence,
    setIntent: vi.fn(),
    submittedDraftSnapshotsRef: { current: {} },
    startConversation: vi.fn(() => null),
    submitPromptRef: { current: vi.fn() },
    transientConversation: null,
    workspaceId: "workspace-1"
  } as unknown as Parameters<typeof useAgentGUISubmitInteractionActions>[0];
  return {
    input,
    sessionEngine,
    setDetailError,
    setGoalClearNoticeSequence
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
      agentSessionId: "session-1",
      content: [{ type: "text" as const, text: "first" }],
      draftKey
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

describe("plan-session staged model boundary", () => {
  it("starts a new session when a native model is staged on a plan session", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input } = createGoalControlInput(goalControl as never);
    const stagedNativeSettings = {
      model: "gpt-5.3-codex",
      modelPlanId: null,
      reasoningEffort: null,
      speed: null,
      planMode: false,
      browserUse: true,
      computerUse: true,
      permissionModeId: null
    };
    const startConversation = vi.fn((..._args: unknown[]) => ({
      agentSessionId: "session-2",
      requestId: "activation:session-2"
    }));
    const setDraftSettingsBySessionId = vi.fn();
    const executePrompt = vi.fn();
    const boundaryInput = {
      ...(input as unknown as Record<string, unknown>),
      activeCanonicalComposerSettings: {
        model: "x-ai/grok-4.5",
        modelPlanId: "mp-relay"
      },
      draftSettingsBySessionIdRef: {
        current: { "session-1": stagedNativeSettings }
      },
      executePromptRef: { current: executePrompt },
      setDraftSettingsBySessionId,
      startConversation
    } as unknown as Parameters<typeof useAgentGUISubmitInteractionActions>[0];
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(boundaryInput)
    );

    act(() => {
      result.current.submitPrompt([{ type: "text", text: "hello" }]);
    });

    // Leaving the plan is a session boundary: the staged native settings must
    // ride a new session create instead of silently falling back into the
    // plan-endpointed session (where the native model can never apply).
    expect(startConversation).toHaveBeenCalledTimes(1);
    expect(startConversation.mock.calls[0]?.[3]).toEqual(stagedNativeSettings);
    expect(setDraftSettingsBySessionId).toHaveBeenCalledWith(
      expect.not.objectContaining({ "session-1": expect.anything() })
    );
  });
});

describe("goal controls", () => {
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
