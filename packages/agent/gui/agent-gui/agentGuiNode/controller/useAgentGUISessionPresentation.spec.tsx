import { act, renderHook } from "@testing-library/react";
import {
  createAgentSessionEngine,
  type AgentActivitySessionGoalSyncState,
  type AgentActivityTurn,
  type PendingActivationIntentRecord
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestEngineCommandPort } from "../../../shared/testing/createTestAgentSessionEngine";
import type {
  AgentGUIInteractionReadiness,
  AgentGUIInteractionReadinessSource,
  AgentGUIObservationGap,
  AgentGUIObservationGapSource,
  AgentGUITargetConnectionSource,
  AgentGUITargetConnectionState
} from "../../../types";
import {
  resolveAgentGUISharingRevokedRecovery,
  useAgentGUISessionPresentation
} from "./useAgentGUISessionPresentation";

class FakeTargetConnectionSource implements AgentGUITargetConnectionSource {
  private readonly listeners = new Set<() => void>();
  private state: AgentGUITargetConnectionState = {
    status: "connecting",
    retryAttempt: 0
  };

  getConnectionState(): AgentGUITargetConnectionState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(state: AgentGUITargetConnectionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeObservationGapSource implements AgentGUIObservationGapSource {
  private readonly listeners = new Set<() => void>();
  private gap: AgentGUIObservationGap | null = {
    startedAtUnixMs: 10_000
  };

  getObservationGap(): AgentGUIObservationGap | null {
    return this.gap;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.gap = null;
    for (const listener of this.listeners) listener();
  }
}

class StaticInteractionSource implements AgentGUIInteractionReadinessSource {
  constructor(private readonly state: AgentGUIInteractionReadiness) {}

  getInteractionReadiness() {
    return this.state;
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

describe("useAgentGUISessionPresentation", () => {
  it("projects a revoked selected Home target into the shared status chrome", () => {
    expect(
      resolveAgentGUISharingRevokedRecovery({
        activeConversationId: null,
        selectedAgentTargetOwnerLabel: "Jackson",
        selectedAgentTargetUnavailable: true,
        selectedAgentTargetUnavailableReason: "agent_sharing_revoked",
        sessionRuntimeBlock: null
      })
    ).toEqual({
      kind: "agent-sharing-revoked",
      message: "Jackson stopped sharing this agent",
      canRetry: false
    });
  });

  it("keeps confirmed initial work busy until canonical state takes over", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: vi.fn(() => new Promise(() => undefined))
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const input = {
      activeConversation: null,
      activeConversationId: "session-1",
      activeEngineActiveTurn: null,
      activeEngineAvailability: "available",
      activeEngineHasPendingInteractions: false,
      activeEngineLatestTurn: null as AgentActivityTurn | null,
      activeEngineRuntimeAvailability: null,
      activeEngineRuntimeActivity: "idle" as "idle" | "running",
      activeEngineSession: {
        agentSessionId: "session-1",
        goal: null,
        goalSyncState: null as AgentActivitySessionGoalSyncState | null,
        resumable: true
      },
      activeEngineSettingsUpdate: null,
      activeGoalControlPresentation: {
        agentSessionId: "session-1",
        goal: null,
        optimistic: false,
        status: "idle"
      },
      activeLatestPendingSubmitTurnId: null as string | null,
      activeLiveState: "active",
      activeMessages: [],
      activePendingActivation: null as PendingActivationIntentRecord | null,
      activeSessionState: null,
      activeTimelineItems: [],
      activationError: null,
      activationErrorCode: null,
      activationState: "active",
      activityDisplayStatus: null,
      agentActivityRuntime: {},
      agentTargetsLoading: false,
      composerSupport: {
        model: false,
        reasoningEffort: false,
        permissionMode: false,
        planMode: false,
        planImplementation: false,
        plan: false
      },
      conversation: null,
      currentUserId: "user-1",
      hasUnconfirmedSubmit: true,
      isCreatingConversation: false,
      isInterrupting: false,
      isLoadingMessages: false,
      isRespondingToInteraction: false,
      isSubmitting: false,
      lastRenderStateDiagnosticKeyRef: { current: null },
      pendingApproval: null,
      planImplementationTurnIdRef: { current: null },
      providerReadinessGate: null,
      selectedAgentTargetOwnerLabel: null,
      selectedAgentTargetUnavailable: false,
      selectedAgentTargetUnavailableReason: null,
      serverInteractivePrompt: null,
      sessionEngine,
      targetConnectionAgentTargetId: null,
      workspaceId: "workspace-1"
    } as unknown as Parameters<typeof useAgentGUISessionPresentation>[0];

    const rendered = renderHook(() => useAgentGUISessionPresentation(input));

    expect(rendered.result.current.activeConversationBusy).toBe(true);

    input.activeLatestPendingSubmitTurnId = "turn-1";
    input.hasUnconfirmedSubmit = false;
    rendered.rerender();

    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activePendingActivation = {
      agentSessionId: "session-1",
      agentTargetId: "local:claude-code",
      clientSubmitId: "submit-1",
      commandOutcome: "pending",
      commandSettledAtUnixMs: null,
      content: [{ type: "text", text: "hello" }],
      cwd: "/workspace",
      errorCode: null,
      errorMessage: null,
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
      initialPromptRetracted: false,
      initialTurnExpected: true,
      lastObservedStage: "requested",
      mode: "new",
      requestedAtUnixMs: 1,
      requestId: "request-1",
      snapshotObservedAtUnixMs: null,
      snapshotOutcome: "not_observed",
      status: "requested",
      title: null,
      workspaceId: "workspace-1"
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(true);

    input.activeEngineLatestTurn = {
      agentSessionId: "session-1",
      origin: "user_prompt",
      outcome: "completed",
      phase: "settled",
      settledAtUnixMs: 3,
      startedAtUnixMs: 2,
      turnId: "turn-1",
      updatedAtUnixMs: 3
    };
    rendered.rerender();

    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activePendingActivation = null;
    input.activeEngineLatestTurn = null;
    input.activeEngineRuntimeActivity = "running";
    input.activityDisplayStatus = "working";
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(true);

    input.activeEngineRuntimeActivity = "idle";
    input.activityDisplayStatus = "idle";
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activePendingActivation = {
      agentSessionId: "session-1",
      agentTargetId: "local:claude-code",
      clientSubmitId: "goal-submit-1",
      commandOutcome: "succeeded",
      commandSettledAtUnixMs: 4,
      content: [{ type: "text", text: "/goal ship it" }],
      cwd: "/workspace",
      errorCode: null,
      errorMessage: null,
      expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
      initialGoalControl: { action: "set", objective: "ship it" },
      initialPromptRetracted: false,
      initialTurnExpected: false,
      lastObservedStage: "confirmed",
      mode: "new",
      requestedAtUnixMs: 4,
      requestId: "goal-request-1",
      snapshotObservedAtUnixMs: 4,
      snapshotOutcome: "matched",
      status: "confirmed",
      title: null,
      workspaceId: "workspace-1"
    };
    input.activeGoalControlPresentation = {
      agentSessionId: "session-1",
      goal: { objective: "ship it", status: "active" },
      optimistic: true,
      status: "pending_create"
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(true);

    input.activePendingActivation = {
      ...input.activePendingActivation,
      status: "confirmed"
    };
    input.activeGoalControlPresentation = {
      ...input.activeGoalControlPresentation,
      optimistic: false,
      status: "idle"
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    for (const syncStatus of ["pending", "applying", "unknown"] as const) {
      input.activeEngineSession = {
        ...input.activeEngineSession!,
        goalSyncState: {
          pendingOperationId: null,
          revision: 1,
          syncStatus
        }
      };
      rendered.rerender();
      expect(rendered.result.current.activeConversationBusy).toBe(false);
    }

    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        pendingOperationId: null,
        revision: 1,
        syncStatus: "synced"
      }
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        executionPending: true,
        pendingOperationId: null,
        revision: 1,
        syncStatus: "synced"
      }
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(true);

    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        pendingOperationId: "goal-operation-1",
        revision: 1,
        syncStatus: "synced"
      }
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        executionPending: true,
        pendingOperationId: null,
        revision: 1,
        syncStatus: "diverged"
      }
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        pendingOperationId: "goal-operation-1",
        revision: 1,
        syncStatus: "applying"
      }
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(true);

    for (const syncStatus of ["pending", "unknown"] as const) {
      input.activeEngineSession = {
        ...input.activeEngineSession!,
        goalSyncState: {
          pendingOperationId: "goal-operation-1",
          revision: 1,
          syncStatus
        }
      };
      rendered.rerender();
      expect(rendered.result.current.activeConversationBusy).toBe(true);
    }

    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        executionPending: true,
        pendingOperationId: null,
        revision: 1,
        syncStatus: "synced"
      }
    };

    input.activeEngineLatestTurn = {
      agentSessionId: "session-1",
      origin: "goal_arm",
      phase: "running",
      startedAtUnixMs: 5,
      turnId: "goal-turn-1",
      updatedAtUnixMs: 5
    };
    input.activeEngineRuntimeActivity = "running";
    input.activityDisplayStatus = "working";
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(true);

    input.activeEngineLatestTurn = {
      ...input.activeEngineLatestTurn,
      outcome: "completed",
      phase: "settled",
      settledAtUnixMs: 6,
      updatedAtUnixMs: 6
    };
    input.activityDisplayStatus = "completed";
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activeEngineLatestTurn = {
      ...input.activeEngineLatestTurn,
      error: { message: "Runtime host unavailable" },
      outcome: "failed"
    };
    input.activityDisplayStatus = "failed";
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activeEngineLatestTurn = null;
    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        pendingOperationId: null,
        revision: 1,
        syncStatus: "failed"
      }
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);

    input.activeEngineSession = {
      ...input.activeEngineSession!,
      goalSyncState: {
        pendingOperationId: "goal-operation-1",
        revision: 1,
        syncStatus: "applying"
      }
    };
    for (const status of ["canceled", "failed"] as const) {
      input.activePendingActivation = {
        ...input.activePendingActivation,
        status
      };
      rendered.rerender();
      expect(rendered.result.current.activeConversationBusy).toBe(false);
    }

    input.activePendingActivation = {
      ...input.activePendingActivation,
      status: "confirmed"
    };
    for (const status of [
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete"
    ] as const) {
      input.activeGoalControlPresentation = {
        ...input.activeGoalControlPresentation,
        goal: { objective: "ship it", status }
      };
      rendered.rerender();
      expect(rendered.result.current.activeConversationBusy).toBe(false);
    }

    input.activeGoalControlPresentation = {
      agentSessionId: "session-1",
      goal: null,
      optimistic: false,
      status: "idle"
    };
    input.activePendingActivation = {
      ...input.activePendingActivation,
      initialGoalControl: { action: "clear" }
    };
    rendered.rerender();
    expect(rendered.result.current.activeConversationBusy).toBe(false);
  });

  it("does not expose manual retry for failed activation", () => {
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: vi.fn(() => new Promise(() => undefined))
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const input = {
      activeConversation: null,
      activeConversationId: "session-rejected",
      activeEngineActiveTurn: null,
      activeEngineAvailability: "available",
      activeEngineHasPendingInteractions: false,
      activeEngineLatestTurn: null,
      activeEngineRuntimeAvailability: null,
      activeEngineSession: null,
      activeGoalControlPresentation: {
        agentSessionId: "session-rejected",
        goal: null,
        optimistic: false,
        status: "idle"
      },
      activeLatestPendingSubmitTurnId: null,
      activeLiveState: "failed",
      activeMessages: [],
      activePendingActivation: {
        agentSessionId: "session-rejected",
        agentTargetId: "local:claude-code",
        clientSubmitId: "submit-rejected",
        content: [{ type: "text", text: "hello" }],
        cwd: "/workspace",
        errorCode: "auth_required",
        errorMessage: "Claude Code needs authentication",
        expiresAtUnixMs: Number.MAX_SAFE_INTEGER,
        initialPromptRetracted: false,
        initialTurnExpected: true,
        mode: "new",
        requestedAtUnixMs: 1,
        requestId: "request-rejected",
        status: "failed",
        title: null,
        workspaceId: "workspace-1"
      },
      activeSessionState: null,
      activeTimelineItems: [],
      activationError: "Claude Code needs authentication",
      activationErrorCode: "auth_required",
      activationState: "failed",
      activityDisplayStatus: null,
      agentActivityRuntime: {},
      agentTargetsLoading: false,
      composerSupport: {
        model: false,
        reasoningEffort: false,
        permissionMode: false,
        planMode: false,
        planImplementation: false,
        plan: false
      },
      conversation: null,
      currentUserId: "user-1",
      isCreatingConversation: false,
      isInterrupting: false,
      isLoadingMessages: false,
      isRespondingToInteraction: false,
      isSubmitting: false,
      lastRenderStateDiagnosticKeyRef: { current: null },
      pendingApproval: null,
      planImplementationTurnIdRef: { current: null },
      providerReadinessGate: null,
      selectedAgentTargetOwnerLabel: null,
      selectedAgentTargetUnavailable: false,
      selectedAgentTargetUnavailableReason: null,
      serverInteractivePrompt: null,
      sessionEngine,
      targetConnectionAgentTargetId: null,
      workspaceId: "workspace-1"
    } as unknown as Parameters<typeof useAgentGUISessionPresentation>[0];

    const rendered = renderHook(() => useAgentGUISessionPresentation(input));

    expect(rendered.result.current.sessionChrome.auth).toEqual({
      message: "Claude Code needs authentication"
    });

    input.activationError = "Provider rejected the initial request";
    input.activationErrorCode = null;
    rendered.rerender();

    expect(rendered.result.current.sessionChrome.auth).toBeNull();
    expect(rendered.result.current.sessionChrome.recovery).toEqual({
      kind: "failed",
      message: "Provider rejected the initial request",
      canRetry: false
    });
  });

  it("makes a shared Agent composer editable in the same snapshot that its target connects", () => {
    const targetConnectionSource = new FakeTargetConnectionSource();
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: vi.fn(() => new Promise(() => undefined))
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const input = {
      activeConversation: null,
      activeConversationId: null,
      activeEngineActiveTurn: null,
      activeEngineAvailability: "available",
      activeEngineHasPendingInteractions: false,
      activeEngineLatestTurn: null,
      activeEngineRuntimeAvailability: null,
      activeEngineSession: null,
      activeEngineSettingsUpdate: null,
      activeGoalControlPresentation: {
        agentSessionId: null,
        goal: null,
        optimistic: false,
        status: "idle"
      },
      activeLatestPendingSubmitTurnId: null,
      activeLiveState: "inactive",
      activeMessages: [],
      activePendingActivation: null,
      activeSessionState: null,
      activeTimelineItems: [],
      activationError: null,
      activationErrorCode: null,
      activationState: null,
      activityDisplayStatus: null,
      agentActivityRuntime: {},
      agentTargetsLoading: false,
      composerSupport: {
        model: false,
        reasoningEffort: false,
        permissionMode: false,
        planMode: false,
        planImplementation: false,
        plan: false
      },
      conversation: null,
      currentUserId: "user-1",
      isCreatingConversation: false,
      isInterrupting: false,
      isLoadingMessages: false,
      isRespondingToInteraction: false,
      isSubmitting: false,
      lastRenderStateDiagnosticKeyRef: { current: null },
      pendingApproval: null,
      planImplementationTurnIdRef: { current: null },
      providerReadinessGate: null,
      selectedAgentTargetOwnerLabel: null,
      selectedAgentTargetUnavailable: false,
      selectedAgentTargetUnavailableReason: null,
      serverInteractivePrompt: null,
      sessionEngine,
      targetConnectionAgentTargetId: "shared-agent:shared-1",
      targetConnectionSource,
      workspaceId: "workspace-1"
    } as unknown as Parameters<typeof useAgentGUISessionPresentation>[0];
    const rendered = renderHook(
      ({ renderRevision }) => {
        void renderRevision;
        return useAgentGUISessionPresentation(input);
      },
      { initialProps: { renderRevision: 0 } }
    );

    expect(rendered.result.current.composerGate).toMatchObject({
      runtime: { status: "blocked", reason: "target_connection" },
      editor: { status: "blocked", reason: "runtime_blocked" },
      submission: { status: "blocked", reason: "runtime_blocked" }
    });

    act(() => {
      targetConnectionSource.set({ status: "connected", retryAttempt: 0 });
    });

    expect(rendered.result.current.composerGate).toMatchObject({
      runtime: { status: "ready", reason: null },
      editor: { status: "editable", reason: null },
      submission: { status: "ready", reason: null }
    });
    const readyGate = rendered.result.current.composerGate;

    rendered.rerender({ renderRevision: 1 });

    expect(rendered.result.current.composerGate).toBe(readyGate);
  });

  it("keeps target and Turn recovery outside exact Interaction readiness authority", () => {
    const targetConnectionSource = new FakeTargetConnectionSource();
    targetConnectionSource.set({ status: "connected", retryAttempt: 0 });
    const observationGapSource = new FakeObservationGapSource();
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: vi.fn(() => new Promise(() => undefined))
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const input = {
      activeConversation: null,
      activeConversationId: "session-1",
      activeEngineActiveTurn: {
        agentSessionId: "session-1",
        origin: "user_prompt",
        phase: "running",
        startedAtUnixMs: 1,
        turnId: "turn-1",
        updatedAtUnixMs: 1
      },
      activeEngineAvailability: "available",
      activeEngineHasPendingInteractions: false,
      activeEngineLatestTurn: null,
      activeEngineRuntimeAvailability: null,
      activeEngineSession: {
        agentSessionId: "session-1",
        goal: null,
        resumable: true
      },
      activeEngineSettingsUpdate: null,
      activeGoalControlPresentation: {
        agentSessionId: "session-1",
        goal: null,
        optimistic: false,
        status: "idle"
      },
      activeLatestPendingSubmitTurnId: null,
      activeLiveState: "active",
      activeMessages: [],
      activePendingActivation: null,
      activeSessionState: null,
      activeTimelineItems: [],
      activationError: null,
      activationErrorCode: null,
      activationState: "active",
      activityDisplayStatus: null,
      agentActivityRuntime: {},
      agentTargetsLoading: false,
      composerSupport: {
        model: false,
        reasoningEffort: false,
        permissionMode: false,
        planMode: false,
        planImplementation: false,
        plan: false
      },
      conversation: null,
      currentUserId: "user-1",
      isCreatingConversation: false,
      isInterrupting: false,
      isLoadingMessages: false,
      isRespondingToInteraction: false,
      isSubmitting: false,
      lastRenderStateDiagnosticKeyRef: { current: null },
      observationGapSource,
      pendingApproval: null,
      planImplementationTurnIdRef: { current: null },
      providerReadinessGate: null,
      selectedAgentTargetOwnerLabel: null,
      selectedAgentTargetUnavailable: false,
      selectedAgentTargetUnavailableReason: null,
      serverInteractivePrompt: null,
      sessionEngine,
      targetConnectionAgentTargetId: "shared-agent:shared-1",
      targetConnectionSource,
      workspaceId: "workspace-1"
    } as unknown as Parameters<typeof useAgentGUISessionPresentation>[0];
    const rendered = renderHook(() => useAgentGUISessionPresentation(input));

    expect(rendered.result.current.sessionChrome.recovery).toMatchObject({
      kind: "transport-connecting",
      message: "Synchronizing the latest task progress…"
    });
    expect(rendered.result.current.composerGate.runtime).toMatchObject({
      status: "blocked",
      reason: "target_connection"
    });

    act(() => {
      targetConnectionSource.set({ status: "unavailable", retryAttempt: 1 });
    });
    expect(rendered.result.current.sessionChrome.recovery).toMatchObject({
      kind: "transport-unavailable"
    });

    input.interactionReadinessSource = new StaticInteractionSource({
      status: "ready"
    });
    input.pendingApproval = {
      kind: "approval",
      id: "approval-1",
      agentSessionId: "session-1",
      turnId: "turn-1",
      requestId: "request-1",
      callId: "call-1",
      title: "Allow command?",
      toolName: "shell",
      status: "pending",
      input: null,
      options: [],
      occurredAtUnixMs: 1
    };
    rendered.rerender();

    expect(rendered.result.current.sessionChrome).toMatchObject({
      approval: { requestId: "request-1" },
      recovery: null
    });
    expect(rendered.result.current.composerGate.runtime).toMatchObject({
      status: "blocked",
      reason: "target_connection"
    });
    expect(rendered.result.current.isRespondingApproval).toBe(false);

    const blockedInteractionCases = [
      {
        reason: "synchronizing",
        recoveryKind: "transport-connecting",
        preservesApproval: true
      },
      {
        reason: "owner_offline",
        recoveryKind: "transport-unavailable",
        preservesApproval: true
      },
      {
        reason: "binding_revoked",
        recoveryKind: "agent-sharing-revoked",
        preservesApproval: false
      }
    ] as const;
    for (const blockedCase of blockedInteractionCases) {
      input.interactionReadinessSource = new StaticInteractionSource({
        status: "blocked",
        reason: blockedCase.reason
      });
      rendered.rerender();

      expect(rendered.result.current.sessionChrome.recovery).toMatchObject({
        kind: blockedCase.recoveryKind
      });
      expect(rendered.result.current.sessionChrome.approval).toEqual(
        blockedCase.preservesApproval
          ? expect.objectContaining({ requestId: "request-1" })
          : null
      );
      expect(rendered.result.current.composerGate.runtime).toMatchObject({
        status: "blocked",
        reason: "target_connection"
      });
      expect(rendered.result.current.isRespondingApproval).toBe(true);
    }

    const promptAwareReadinessSource = {
      getInteractionReadiness: vi.fn((identity: { requestId: string }) =>
        identity.requestId === "question-1"
          ? ({ status: "ready" } as const)
          : ({ status: "blocked", reason: "synchronizing" } as const)
      ),
      subscribe: vi.fn(() => () => undefined)
    };
    input.interactionReadinessSource = promptAwareReadinessSource;
    input.serverInteractivePrompt = {
      kind: "ask-user",
      agentSessionId: "session-1",
      turnId: "turn-2",
      requestId: "question-1",
      title: "Choose a deployment",
      questions: []
    };
    rendered.rerender();

    expect(
      promptAwareReadinessSource.getInteractionReadiness
    ).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      requestId: "question-1",
      turnId: "turn-2",
      workspaceId: "workspace-1"
    });
    expect(
      promptAwareReadinessSource.getInteractionReadiness
    ).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      requestId: "request-1",
      turnId: "turn-1",
      workspaceId: "workspace-1"
    });
    expect(rendered.result.current.pendingInteractivePrompt).toMatchObject({
      requestId: "question-1"
    });
    expect(rendered.result.current.pendingApproval).toMatchObject({
      requestId: "request-1"
    });
    expect(rendered.result.current.sessionChrome.recovery).toBeNull();
    expect(rendered.result.current.composerGate.runtime).toMatchObject({
      status: "blocked",
      reason: "target_connection"
    });
    expect(rendered.result.current.isRespondingApproval).toBe(true);
    expect(rendered.result.current.isRespondingInteractivePrompt).toBe(false);

    input.interactionReadinessSource = {
      getInteractionReadiness: vi.fn((identity: { requestId: string }) =>
        identity.requestId === "question-1"
          ? ({ status: "blocked", reason: "synchronizing" } as const)
          : ({ status: "ready" } as const)
      ),
      subscribe: vi.fn(() => () => undefined)
    };
    rendered.rerender();

    expect(rendered.result.current.sessionChrome.recovery).toMatchObject({
      kind: "transport-connecting",
      interactionScoped: true
    });
    expect(rendered.result.current.isRespondingApproval).toBe(false);
    expect(rendered.result.current.isRespondingInteractivePrompt).toBe(true);

    input.interactionReadinessSource = new StaticInteractionSource({
      status: "ready"
    });
    input.serverInteractivePrompt = null;
    rendered.rerender();
    act(() => {
      targetConnectionSource.set({ status: "connected", retryAttempt: 0 });
      observationGapSource.clear();
    });

    expect(rendered.result.current.sessionChrome.recovery).toBeNull();
    expect(rendered.result.current.composerGate.runtime).toMatchObject({
      status: "ready",
      reason: null
    });
  });

  it("keeps shared history visible while revoked sharing blocks commands with owner copy", () => {
    const targetConnectionSource = new FakeTargetConnectionSource();
    targetConnectionSource.set({ status: "unavailable", retryAttempt: 4 });
    const sessionEngine = createAgentSessionEngine({
      clock: { nowUnixMs: () => 1 },
      commandPort: createTestEngineCommandPort({
        execute: vi.fn(() => new Promise(() => undefined))
      }),
      identity: { origin: "test", workspaceId: "workspace-1" },
      scheduler: { schedule: () => ({ cancel() {} }) }
    });
    const input = {
      activeConversation: null,
      activeConversationId: "session-1",
      activeEngineActiveTurn: null,
      activeEngineAvailability: "available",
      activeEngineHasPendingInteractions: false,
      activeEngineLatestTurn: null,
      activeEngineRuntimeAvailability: {
        state: "blocked",
        reason: "agent_sharing_revoked",
        ownerLabel: "riceballmama"
      },
      activeEngineSession: {
        agentSessionId: "session-1",
        goal: null,
        resumable: true
      },
      activeEngineSettingsUpdate: null,
      activeGoalControlPresentation: {
        agentSessionId: "session-1",
        goal: null,
        optimistic: false,
        status: "idle"
      },
      activeLatestPendingSubmitTurnId: null,
      activeLiveState: "active",
      activeMessages: [],
      activePendingActivation: null,
      activeSessionState: null,
      activeTimelineItems: [{ role: "user" }],
      activationError: null,
      activationErrorCode: null,
      activationState: "active",
      activityDisplayStatus: null,
      agentActivityRuntime: {},
      agentTargetsLoading: false,
      composerSupport: {
        model: false,
        reasoningEffort: false,
        permissionMode: false,
        planMode: false,
        planImplementation: false,
        plan: false
      },
      conversation: null,
      currentUserId: "user-1",
      isCreatingConversation: false,
      isInterrupting: false,
      isLoadingMessages: false,
      isRespondingToInteraction: false,
      isSubmitting: false,
      lastRenderStateDiagnosticKeyRef: { current: null },
      pendingApproval: null,
      planImplementationTurnIdRef: { current: null },
      providerReadinessGate: null,
      selectedAgentTargetOwnerLabel: null,
      selectedAgentTargetUnavailable: false,
      selectedAgentTargetUnavailableReason: null,
      serverInteractivePrompt: null,
      sessionEngine,
      targetConnectionAgentTargetId: "shared-agent:shared-1",
      targetConnectionSource,
      workspaceId: "workspace-1"
    } as unknown as Parameters<typeof useAgentGUISessionPresentation>[0];

    const rendered = renderHook(() => useAgentGUISessionPresentation(input));

    expect(rendered.result.current.sessionChrome.recovery).toEqual({
      kind: "agent-sharing-revoked",
      message: "riceballmama stopped sharing this agent",
      canRetry: false
    });
    expect(rendered.result.current.hasSentUserMessage).toBe(true);
    expect(rendered.result.current.composerGate).toMatchObject({
      runtime: {
        status: "blocked",
        reason: "session_runtime",
        sessionRuntimeReason: "agent_sharing_revoked"
      },
      editor: { status: "blocked", reason: "runtime_blocked" },
      submission: { status: "blocked", reason: "runtime_blocked" }
    });
  });
});
