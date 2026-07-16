import { renderHook, waitFor } from "@testing-library/react";
import type { AgentSessionEngine } from "@tutti-os/agent-activity-core";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUINodeData } from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import {
  clearFailedAgentGUIActivationSelection,
  shouldMarkActiveConversationRead
} from "./useAgentGUIConversationSelectionController";
import { useAgentGUIConversationSelectionController } from "./useAgentGUIConversationSelectionController";
import { useAgentGUIConversationRouting } from "./useAgentGUIConversationRouting";
import type { ConversationIntent } from "./useAgentConversationSelection";
import type { useAgentGUIActivation } from "./useAgentGUIActivation";

describe("clearFailedAgentGUIActivationSelection", () => {
  it("does not clear a newer external selection", () => {
    const current = {
      lastActiveAgentSessionId: "session-newer",
      provider: "codex" as const
    };

    expect(
      clearFailedAgentGUIActivationSelection(current, "session-failed")
    ).toBe(current);
    expect(
      clearFailedAgentGUIActivationSelection(current, "session-newer")
        .lastActiveAgentSessionId
    ).toBeNull();
  });

  it("does not reinterpret the failed selection persistence echo as a new request", async () => {
    const failedAgentSessionId = "session-failed";
    const data: AgentGUINodeData = {
      provider: "codex",
      lastActiveAgentSessionId: failedAgentSessionId
    };
    const onDataChange = vi.fn();
    const routeSelections = vi.fn();
    const transientConversation = {
      id: failedAgentSessionId
    } as AgentGUIConversationSummary;

    const { result } = renderHook(() => {
      const [activeConversationId, setActiveConversationId] = useState<
        string | null
      >(failedAgentSessionId);
      const [intent, setIntent] = useState<ConversationIntent>({
        tag: "active",
        id: failedAgentSessionId
      });
      const [isComposerHome, setIsComposerHome] = useState(false);
      const activeConversationIdRef = useRef<string | null>(
        failedAgentSessionId
      );
      const isComposerHomeRef = useRef(false);
      const dataRef = useRef(data);

      useAgentGUIConversationSelectionController({
        activation: {
          clearFailure: vi.fn(),
          unactivate: vi.fn(() => Promise.resolve())
        } as unknown as ReturnType<typeof useAgentGUIActivation>,
        activeConversationId,
        activeConversationIdRef,
        activePendingActivation:
          activeConversationId === failedAgentSessionId
            ? {
                agentSessionId: failedAgentSessionId,
                errorMessage: "create failed",
                mode: "new",
                status: "failed"
              }
            : null,
        agentActivityRuntime: {} as AgentActivityRuntime,
        attentionReadRecordsBySessionId: {},
        conversationIdsRef: { current: new Set() },
        conversationListQuery: {},
        currentUserId: null,
        data,
        dataRef,
        intent,
        isComposerHomeRef,
        isMountedRef: { current: true },
        loadDraftComposerOptions: vi.fn(),
        markSelectedConversationDetailPending: vi.fn(() => null),
        onDataChangeRef: { current: onDataChange },
        reloadSelectedConversationRef: { current: vi.fn() },
        sessionEngine: {
          dispatch: vi.fn(),
          getSnapshot: vi.fn(() => ({}))
        } as unknown as AgentSessionEngine,
        setActiveConversationId,
        setDetailError: vi.fn(),
        setIntent,
        setIsComposerHome: (next) => {
          setIsComposerHome(next);
        },
        setIsLoadingMessages: vi.fn(),
        workspaceId: "workspace-1"
      });
      useAgentGUIConversationRouting({
        activeConversationIdRef,
        conversationListQuery: {},
        conversations: [],
        conversationsRef: { current: [] },
        handledOpenSessionSequenceRef: { current: null },
        hasLoadedConversations: true,
        intent,
        openSessionRequest: null,
        pendingOpenSessionRequestRef: { current: null },
        previewMode: false,
        selectConversation: (agentSessionId) => {
          routeSelections(agentSessionId);
          activeConversationIdRef.current = agentSessionId;
          setActiveConversationId(agentSessionId);
          setIntent({ tag: "active", id: agentSessionId });
        },
        sessionEngine: {
          dispatch: vi.fn(),
          getSnapshot: vi.fn(() => ({}))
        } as unknown as AgentSessionEngine,
        setIntent,
        transientConversation,
        workspaceId: "workspace-1"
      });

      return { activeConversationId, intent, isComposerHome };
    });

    await waitFor(() => {
      expect(result.current).toEqual({
        activeConversationId: null,
        intent: { tag: "home" },
        isComposerHome: true
      });
    });
    expect(onDataChange).toHaveBeenCalledOnce();
    expect(routeSelections).not.toHaveBeenCalled();
  });
});

describe("shouldMarkActiveConversationRead", () => {
  const record = {
    completionKey: "turn:session-1:turn-1:completed",
    isUnread: true,
    kind: "completed" as const,
    markedUnreadByUser: false
  };

  it("keeps a manually marked unread completion unread in the current selection", () => {
    expect(
      shouldMarkActiveConversationRead({
        activeConversationId: "session-1",
        previousActiveConversationId: "session-1",
        record: { ...record, markedUnreadByUser: true }
      })
    ).toBe(false);
  });

  it("marks manual unread as read after the session is selected again", () => {
    expect(
      shouldMarkActiveConversationRead({
        activeConversationId: "session-1",
        previousActiveConversationId: "session-2",
        record: { ...record, markedUnreadByUser: true }
      })
    ).toBe(true);
  });

  it("still marks live or hydrated unread attention as read while selected", () => {
    expect(
      shouldMarkActiveConversationRead({
        activeConversationId: "session-1",
        previousActiveConversationId: "session-1",
        record
      })
    ).toBe(true);
  });
});
