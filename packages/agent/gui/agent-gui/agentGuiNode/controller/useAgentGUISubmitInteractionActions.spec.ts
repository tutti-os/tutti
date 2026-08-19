import { act, renderHook, waitFor } from "@testing-library/react";
import {
  createAgentSessionEngine,
  selectSessionGoalControlPresentation,
  type AgentActivityGoalControlInput,
  type AgentActivityGoalControlResult,
  type AgentSessionGoalControlEffectInput,
  type EngineEffectOptions
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import { agentComposerDraftPrompt } from "../model/agentComposerDraft";
import {
  clearSubmittedAgentGUIHomeDraft,
  restoreFailedAgentGUIHomeDraft
} from "./agentGuiController.homeDraftHelpers";
import {
  agentGUISubmitSettlementError,
  typedGoalControlFromComposer,
  useAgentGUISubmitInteractionActions
} from "./useAgentGUISubmitInteractionActions";

const draftKey = "node-default:codex:local:codex";

it("preserves a failed submit reason for package-owned presentation", () => {
  expect(
    agentGUISubmitSettlementError({
      errorCode: "workspace_operation_failed",
      errorMessage: "agent process cleanup is still pending",
      errorReason: "agent.process_cleanup_pending"
    })
  ).toMatchObject({
    code: "workspace_operation_failed",
    message: "agent process cleanup is still pending",
    reason: "agent.process_cleanup_pending"
  });
});

function draft(prompt: string): AgentComposerDraft {
  return [{ type: "text", text: prompt }];
}

function createGoalControlInput(
  goalControl: (
    input: AgentActivityGoalControlInput
  ) => Promise<AgentActivityGoalControlResult>
) {
  const baseSession = {
    activeTurnId: null,
    agentSessionId: "session-1",
    cwd: "/workspace",
    goal: { objective: "existing goal", status: "active" as const },
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title: "Session",
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1"
  };
  const sessionEngine = createAgentSessionEngine({
    clock: { nowUnixMs: () => 1 },
    commandPort: {
      kind: "typed",
      effects: {
        controlGoal: async (
          effectInput: AgentSessionGoalControlEffectInput,
          options?: EngineEffectOptions
        ) => {
          await goalControl({ ...effectInput, signal: options?.signal });
          const goal =
            effectInput.action === "clear"
              ? null
              : effectInput.action === "set"
                ? {
                    objective: effectInput.objective!,
                    status: "active" as const
                  }
                : {
                    ...baseSession.goal,
                    status:
                      effectInput.action === "pause"
                        ? ("paused" as const)
                        : ("active" as const)
                  };
          return {
            goal,
            session: { ...baseSession, goal, updatedAtUnixMs: 2 }
          };
        }
      },
      execute: async () => undefined
    } as never,
    identity: { origin: "test", workspaceId: "workspace-1" },
    scheduler: { schedule: () => ({ cancel() {} }) }
  });
  sessionEngine.dispatch({ session: baseSession, type: "session/upserted" });
  const setDetailError = vi.fn();
  const setGoalClearNoticeSequence = vi.fn();
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
    activeConversationId: "session-1",
    activeConversationIdRef: { current: "session-1" },
    activeEngineActiveTurn: null,
    activeEnginePendingInteractions: [],
    agentActivityRuntime: {},
    conversationListQuery: {},
    conversationsRef: { current: [] },
    dataRef: { current: {} },
    draftByScopeKeyRef,
    executePromptRef: { current: vi.fn() },
    goalControlSupported: true,
    isComposerHomeRef: { current: false },
    isCurrentConversation: (agentSessionId: string) =>
      agentSessionId === "session-1",
    isRespondingToInteraction: false,
    isSessionMarkedNonResumable: () => false,
    persistActiveConversation: vi.fn(),
    planActionsRef: {
      current: { implement: vi.fn(), feedback: vi.fn(), skip: vi.fn() }
    },
    promptImagesSupported: true,
    sessionEngine,
    setActiveConversationId: vi.fn(),
    setDetailError,
    setDraftByScopeKey,
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
    draftByScopeKeyRef,
    sessionEngine,
    setDetailError,
    setDraftByScopeKey,
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
  it("routes activation and active-turn stop through the Engine semantic operation", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine } = createGoalControlInput(
      goalControl as never
    );
    const stopSession = vi.spyOn(sessionEngine, "stopSession");
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() => result.current.interruptCurrentTurn("not running"));

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith({
      agentSessionId: "session-1"
    });
  });
});

describe("interaction submissions", () => {
  it.each([
    ["implement", "implement"],
    ["feedback", "feedback"],
    ["skip", "skip"]
  ] as const)(
    "returns the plan %s handler admission result",
    (action, handler) => {
      const goalControl = vi.fn(async () => undefined);
      const { input } = createGoalControlInput(goalControl as never);
      input.planActionsRef.current[handler] = vi.fn(() => false);
      const { result } = renderHook(() =>
        useAgentGUISubmitInteractionActions(input)
      );

      let admitted = true;
      act(() => {
        admitted = result.current.submitInteractivePrompt({
          action,
          payload: action === "feedback" ? { text: "revise" } : undefined,
          requestId: "turn-1"
        });
      });

      expect(admitted).toBe(false);
      expect(input.planActionsRef.current[handler]).toHaveBeenCalledOnce();
    }
  );

  it("routes the explicit answer through the Engine semantic operation", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine, setDetailError } = createGoalControlInput(
      goalControl as never
    );
    const submitInteractionResponse = vi
      .spyOn(sessionEngine, "submitInteractionResponse")
      .mockReturnValue(true);
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions({
        ...input,
        activeEnginePendingInteractions: [
          {
            agentSessionId: "session-1",
            createdAtUnixMs: 1,
            kind: "question",
            requestId: "request-1",
            status: "pending",
            turnId: "turn-1",
            updatedAtUnixMs: 1
          }
        ]
      })
    );

    let admitted = false;
    act(() => {
      admitted = result.current.submitApprovalOption({
        agentSessionId: " session-1 ",
        optionId: " allow-once ",
        requestId: " request-1 ",
        turnId: " turn-1 "
      });
    });

    expect(admitted).toBe(true);
    expect(submitInteractionResponse).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      optionId: "allow-once",
      requestId: "request-1",
      turnId: "turn-1"
    });
    expect(setDetailError).toHaveBeenCalledWith(null);
  });

  it("rechecks exact Host readiness at the interaction boundary", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine } = createGoalControlInput(
      goalControl as never
    );
    const submitInteractionResponse = vi
      .spyOn(sessionEngine, "submitInteractionResponse")
      .mockReturnValue(true);
    let readiness: "ready" | "blocked" = "blocked";
    const interactionReadinessSource = {
      getInteractionReadiness: vi.fn(() =>
        readiness === "ready"
          ? ({ status: "ready" } as const)
          : ({ status: "blocked", reason: "synchronizing" } as const)
      ),
      subscribe: vi.fn(() => () => undefined)
    };
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions({
        ...input,
        interactionReadinessSource,
        activeEnginePendingInteractions: [
          {
            agentSessionId: "session-1",
            createdAtUnixMs: 1,
            kind: "question",
            requestId: "request-1",
            status: "pending",
            turnId: "turn-1",
            updatedAtUnixMs: 1
          }
        ]
      })
    );

    let admitted = true;
    act(() => {
      admitted = result.current.submitApprovalOption({
        agentSessionId: "session-1",
        optionId: "allow",
        requestId: "request-1",
        turnId: "turn-1"
      });
    });
    expect(admitted).toBe(false);
    expect(submitInteractionResponse).not.toHaveBeenCalled();

    readiness = "ready";
    act(() => {
      admitted = result.current.submitApprovalOption({
        agentSessionId: "session-1",
        optionId: "allow",
        requestId: "request-1",
        turnId: "turn-1"
      });
    });

    expect(admitted).toBe(true);
    expect(
      interactionReadinessSource.getInteractionReadiness
    ).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      requestId: "request-1"
    });
    expect(submitInteractionResponse).toHaveBeenCalledTimes(1);
  });

  it("submits only the exact pending interaction when request ids repeat", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine } = createGoalControlInput(
      goalControl as never
    );
    const submitInteractionResponse = vi
      .spyOn(sessionEngine, "submitInteractionResponse")
      .mockReturnValue(true);
    const interactionReadinessSource = {
      getInteractionReadiness: vi.fn(() => ({ status: "ready" }) as const),
      subscribe: vi.fn(() => () => undefined)
    };
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions({
        ...input,
        interactionReadinessSource,
        activeEnginePendingInteractions: [
          {
            agentSessionId: "session-1",
            createdAtUnixMs: 1,
            kind: "question",
            requestId: "request-1",
            status: "pending",
            turnId: "turn-1",
            updatedAtUnixMs: 1
          },
          {
            agentSessionId: "session-2",
            createdAtUnixMs: 2,
            kind: "approval",
            requestId: "request-1",
            status: "pending",
            turnId: "turn-2",
            updatedAtUnixMs: 2
          }
        ]
      })
    );

    let admitted = false;
    act(() => {
      admitted = result.current.submitInteractivePrompt({
        action: "allow",
        agentSessionId: "session-1",
        requestId: "request-1",
        turnId: "turn-1"
      });
    });

    expect(admitted).toBe(true);
    expect(
      interactionReadinessSource.getInteractionReadiness
    ).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      requestId: "request-1",
      turnId: "turn-1",
      workspaceId: "workspace-1"
    });
    expect(submitInteractionResponse).toHaveBeenCalledWith({
      action: "allow",
      agentSessionId: "session-1",
      requestId: "request-1",
      turnId: "turn-1"
    });
  });

  it("rejects a response without an exact pending interaction identity", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine } = createGoalControlInput(
      goalControl as never
    );
    const submitInteractionResponse = vi.spyOn(
      sessionEngine,
      "submitInteractionResponse"
    );
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    let admitted = true;
    act(() => {
      admitted = result.current.submitInteractivePrompt({
        requestId: "request-1"
      });
    });

    expect(admitted).toBe(false);
    expect(submitInteractionResponse).not.toHaveBeenCalled();
  });
});

describe("existing-session prompt submission", () => {
  it("captures the exact active Turn for guidance before routing to the Engine", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine } = createGoalControlInput(
      goalControl as never
    );
    input.activeEngineActiveTurn = { turnId: "turn-target" } as never;
    const submitPrompt = vi
      .spyOn(sessionEngine, "submitPrompt")
      .mockReturnValue({ accepted: true, queued: false });
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitGuidancePrompt(
        [{ type: "text", text: "steer this turn" }],
        undefined,
        { capabilityRefs: [{ capability: "tutti", source: "slash_command" }] }
      )
    );

    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
        routing: "send_now",
        targetTurnId: "turn-target"
      })
    );
  });

  it("routes submission through the Engine semantic operation", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, draftByScopeKeyRef, sessionEngine, setDraftByScopeKey } =
      createGoalControlInput(goalControl as never);
    draftByScopeKeyRef.current = {
      "session:session-1": draft("continue")
    };
    const submitPrompt = vi
      .spyOn(sessionEngine, "submitPrompt")
      .mockReturnValue({ accepted: true, queued: false });
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt(
        [{ type: "text", text: "continue" }],
        " Continue ",
        {
          capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
          requiredSettingsPatch: { computerUse: true }
        }
      )
    );

    expect(submitPrompt).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      capabilityRefs: [{ capability: "tutti", source: "slash_command" }],
      clientSubmitId: expect.any(String),
      content: [{ type: "text", text: "continue" }],
      displayPrompt: " Continue ",
      requiredSettingsPatch: { computerUse: true },
      runtimeContent: [{ type: "text", text: "continue" }],
      submitDiagnostics: expect.objectContaining({
        source: "agent-gui"
      })
    });
    expect(setDraftByScopeKey).toHaveBeenCalledTimes(1);
    expect(
      agentComposerDraftPrompt(draftByScopeKeyRef.current["session:session-1"]!)
    ).toBe("");
  });

  it("clears the draft captured by the Composer when the controller ref is stale", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, draftByScopeKeyRef, sessionEngine, setDraftByScopeKey } =
      createGoalControlInput(goalControl as never);
    const submittedDraft = draft("continue");
    draftByScopeKeyRef.current = {
      "session:session-1": draft("stale projection")
    };
    const submitPrompt = vi
      .spyOn(sessionEngine, "submitPrompt")
      .mockReturnValue({ accepted: true, queued: true });
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    setDraftByScopeKey.mockImplementationOnce((update) => {
      const current = { "session:session-1": submittedDraft };
      const next = typeof update === "function" ? update(current) : update;
      draftByScopeKeyRef.current = next;
    });

    act(() =>
      result.current.submitPrompt(
        [{ type: "text", text: "continue" }],
        undefined,
        { submittedDraft }
      )
    );

    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [{ type: "text", text: "continue" }]
      })
    );
    expect(
      agentComposerDraftPrompt(draftByScopeKeyRef.current["session:session-1"]!)
    ).toBe("");
  });

  it("keeps the draft when the Engine does not admit the submission", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, draftByScopeKeyRef, sessionEngine, setDraftByScopeKey } =
      createGoalControlInput(goalControl as never);
    draftByScopeKeyRef.current = {
      "session:session-1": draft("continue")
    };
    vi.spyOn(sessionEngine, "submitPrompt").mockReturnValue({
      accepted: false,
      queued: false
    });
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt([{ type: "text", text: "continue" }])
    );

    expect(setDraftByScopeKey).not.toHaveBeenCalled();
    expect(
      agentComposerDraftPrompt(draftByScopeKeyRef.current["session:session-1"]!)
    ).toBe("continue");
  });
});

describe("goal controls", () => {
  it("submits typed Goal text normally when Goal control is unsupported", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine } = createGoalControlInput(
      goalControl as never
    );
    input.goalControlSupported = false;
    const submitPrompt = vi
      .spyOn(sessionEngine, "submitPrompt")
      .mockReturnValue({ accepted: true, queued: false });
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() =>
      result.current.submitPrompt([
        { type: "text", text: "/goal count to ten" }
      ])
    );

    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "session-1",
        content: [{ type: "text", text: "/goal count to ten" }]
      })
    );
    expect(goalControl).not.toHaveBeenCalled();
  });

  it("publishes the Engine-owned optimistic goal before transport settles", async () => {
    const goalControl = vi.fn(() => new Promise<void>(() => {}));
    const { input, sessionEngine } = createGoalControlInput(
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

    expect(
      selectSessionGoalControlPresentation(
        sessionEngine.getSnapshot(),
        "session-1"
      )
    ).toMatchObject({
      goal: { objective: "count to ten", status: "active" },
      optimistic: true,
      status: "pending"
    });
    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
  });

  it("delegates a new-session goal to the shared activation intent", () => {
    const goalControl = vi.fn(async () => undefined);
    const { input } = createGoalControlInput(goalControl as never);
    input.activeConversationId = null;
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
    expect(
      selectSessionGoalControlPresentation(
        sessionEngine.getSnapshot(),
        "session-1"
      ).status
    ).toBe("succeeded");
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
      Promise.reject(
        Object.assign(new Error("goal failed"), { code: "invalid_request" })
      )
    );
    const { input, draftByScopeKeyRef, setDetailError, setDraftByScopeKey } =
      createGoalControlInput(goalControl as never);
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
  });

  it("settles an outcome-unknown retry with the Engine's effective identity", async () => {
    const goalControl = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined);
    const { input, draftByScopeKeyRef, sessionEngine } = createGoalControlInput(
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
    await waitFor(() =>
      expect(
        selectSessionGoalControlPresentation(
          sessionEngine.getSnapshot(),
          "session-1"
        ).status
      ).toBe("unknown")
    );
    const firstClientSubmitId = goalControl.mock.calls[0]?.[0].clientSubmitId;

    act(() =>
      result.current.submitPrompt([
        { type: "text", text: "/goal count to ten" }
      ])
    );

    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(2));
    expect(goalControl.mock.calls[1]?.[0].clientSubmitId).toBe(
      firstClientSubmitId
    );
    await waitFor(() =>
      expect(
        agentComposerDraftPrompt(draftByScopeKeyRef.current[sessionDraftKey]!)
      ).toBe("")
    );
  });

  it("clears through the control API without creating a prompt submit", async () => {
    const goalControl = vi.fn(async () => undefined);
    const { input, sessionEngine, setGoalClearNoticeSequence } =
      createGoalControlInput(goalControl as never);
    const { result } = renderHook(() =>
      useAgentGUISubmitInteractionActions(input)
    );

    act(() => result.current.goalControl("clear"));

    await waitFor(() => expect(goalControl).toHaveBeenCalledTimes(1));
    expect(goalControl).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "clear",
        agentSessionId: "session-1",
        clientSubmitId: expect.stringMatching(/^goal-control:/),
        workspaceId: "workspace-1"
      })
    );
    expect(setGoalClearNoticeSequence).toHaveBeenCalledTimes(1);
    expect(
      selectSessionGoalControlPresentation(
        sessionEngine.getSnapshot(),
        "session-1"
      ).goal
    ).toBeNull();
  });

  it("reports a clear failure without showing a success toast", async () => {
    const error = Object.assign(new Error("clear failed"), {
      code: "invalid_request"
    });
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

describe("typedGoalControlFromComposer", () => {
  it("typed Goal semantics ignore presentation-only displayPrompt", () => {
    expect(
      typedGoalControlFromComposer(
        [{ type: "text", text: "/goal clear" }],
        "clear chip",
        true
      )
    ).toEqual({ action: "clear" });
    expect(
      typedGoalControlFromComposer(
        [{ type: "text", text: "ordinary prompt" }],
        "/goal clear",
        true
      )
    ).toBeNull();
  });

});
