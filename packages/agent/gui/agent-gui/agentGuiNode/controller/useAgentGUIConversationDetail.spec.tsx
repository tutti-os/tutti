import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { buildAgentComposerDraft } from "../model/agentComposerDraft";
import { useAgentGUIConversationDetail } from "./useAgentGUIConversationDetail";

type ConversationDetailInput = Parameters<
  typeof useAgentGUIConversationDetail
>[0];

function conversationDetailInput(
  overrides: Partial<ConversationDetailInput> = {}
): ConversationDetailInput {
  return {
    activeCancelStatus: null,
    activeConversation: null,
    activeConversationId: "session-1",
    activeConversationLiveState: "inactive",
    activeEngineError: null,
    activeMessages: [],
    activePendingInteractions: [],
    activeQueuedPromptInFlight: null,
    activeQueuedPrompts: [],
    activeQueueStatus: "active",
    activeSessionFamily: {
      childSessions: [],
      messagesBySessionId: {},
      pendingInteractions: [],
      rootSession: null
    },
    activeSessionReconcileError: null,
    activeSessionView: null,
    activeTimelineItems: [],
    activeTurn: null,
    agentActivityRuntime: {} as AgentActivityRuntime,
    avoidGroupingEdits: false,
    codeFor: () => null,
    detailError: null,
    draftByScopeKey: {},
    errorFor: () => null,
    providerComposerOptions: null,
    selectedComposerTargetData: {
      agentTargetId: null,
      data: {
        conversationRailWidthPx: null,
        lastActiveAgentSessionId: "session-1",
        provider: "codex"
      },
      provider: "codex",
      targetId: "local:codex"
    },
    selectedProjectPath: "/workspace",
    sessionEngine: createTestAgentSessionEngine("workspace-1"),
    workspaceId: "workspace-1",
    workspacePath: "/workspace",
    ...overrides
  };
}

describe("useAgentGUIConversationDetail", () => {
  it("restores provider commands from composer options before an engine event is available", () => {
    const { result } = renderHook(() =>
      useAgentGUIConversationDetail(
        conversationDetailInput({
          providerComposerOptions: {
            commands: [{ name: "memory", description: "Manage memory" }],
            skills: []
          } as never,
          selectedComposerTargetData: {
            agentTargetId: "extension:gemini",
            data: {
              conversationRailWidthPx: null,
              lastActiveAgentSessionId: "session-1",
              provider: "acp:gemini"
            },
            provider: "acp:gemini",
            targetId: "extension:gemini"
          }
        })
      )
    );

    expect(result.current.availableCommands).toEqual([
      { name: "memory", description: "Manage memory" }
    ]);
  });

  it("surfaces session reconcile errors through the detail error channel", () => {
    const { result } = renderHook(() =>
      useAgentGUIConversationDetail(
        conversationDetailInput({
          activeSessionReconcileError: "detail reconcile failed"
        })
      )
    );

    expect(result.current.effectiveDetailError).toBe("detail reconcile failed");
  });

  it("keeps the composer in interrupting state after durable cancel acceptance", () => {
    const { result } = renderHook(() =>
      useAgentGUIConversationDetail(
        conversationDetailInput({ activeCancelStatus: "accepted" })
      )
    );

    expect(result.current.isInterrupting).toBe(true);
  });

  it("keeps the conversation projection stable for a draft-only update", () => {
    const input = conversationDetailInput({
      activeConversation: conversationSummary()
    });
    const rendered = renderHook(
      ({ draftByScopeKey }) =>
        useAgentGUIConversationDetail({ ...input, draftByScopeKey }),
      { initialProps: { draftByScopeKey: {} } }
    );
    const previousConversation = rendered.result.current.conversation;

    rendered.rerender({
      draftByScopeKey: {
        "session:session-1": buildAgentComposerDraft({ prompt: "a" })
      }
    });

    expect(rendered.result.current.conversation).toBe(previousConversation);
  });

  it("preserves canonical Session lifecycle capabilities in the timeline projection", () => {
    const session = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      latestTurnInteractions: [],
      lifecycleCapabilities: {
        fork: false,
        forkThroughTurn: true
      },
      pendingInteractions: [],
      provider: "codex",
      providerSessionId: "thread-1",
      title: "Conversation",
      workspaceId: "workspace-1"
    });

    const { result } = renderHook(() =>
      useAgentGUIConversationDetail(
        conversationDetailInput({
          activeConversation: conversationSummary(),
          activeSessionFamily: {
            childSessions: [],
            messagesBySessionId: {},
            pendingInteractions: [],
            rootSession: session
          }
        })
      )
    );

    expect(
      result.current.conversation?.sourceDetail.session.lifecycleCapabilities
    ).toEqual({
      fork: false,
      forkThroughTurn: true,
      forkThroughTurnIds: [],
      forkThroughTurnIdsKnown: false
    });
  });

  it("refreshes the timeline when only canonical Fork capability changes", () => {
    const baseSession = normalizeAgentActivitySession({
      activeTurnId: null,
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      cwd: "/workspace",
      latestTurnInteractions: [],
      lifecycleCapabilities: {
        fork: false,
        forkThroughTurn: false
      },
      pendingInteractions: [],
      provider: "codex",
      providerSessionId: "thread-1",
      title: "Conversation",
      workspaceId: "workspace-1"
    });
    const rendered = renderHook(
      ({ forkThroughTurn }) =>
        useAgentGUIConversationDetail(
          conversationDetailInput({
            activeConversation: conversationSummary(),
            activeSessionFamily: {
              childSessions: [],
              messagesBySessionId: {},
              pendingInteractions: [],
              rootSession: normalizeAgentActivitySession({
                ...baseSession,
                lifecycleCapabilities: {
                  fork: false,
                  forkThroughTurn
                }
              })
            }
          })
        ),
      { initialProps: { forkThroughTurn: false } }
    );
    const previousConversation = rendered.result.current.conversation;

    rendered.rerender({ forkThroughTurn: true });

    expect(rendered.result.current.conversation).not.toBe(previousConversation);
    expect(
      rendered.result.current.conversation?.sourceDetail.session
        .lifecycleCapabilities
    ).toEqual({
      fork: false,
      forkThroughTurn: true,
      forkThroughTurnIds: [],
      forkThroughTurnIdsKnown: false
    });
  });
});

function conversationSummary(): AgentGUIConversationSummary {
  return {
    agentTargetId: "local:codex",
    cwd: "/workspace",
    id: "session-1",
    provider: "codex",
    status: "ready",
    title: "Conversation",
    titleFallback: null,
    updatedAtUnixMs: 1,
    userId: "user-1"
  };
}
