import { act, renderHook } from "@testing-library/react";
import { createAgentSessionEngine } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import { createTestEngineCommandPort } from "../../../shared/testing/createTestAgentSessionEngine";
import type {
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

  it("keeps recovery chrome and commands blocked until an exact observation gap clears", () => {
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

    act(() => observationGapSource.clear());

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
