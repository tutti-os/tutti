import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { useAgentConversationMessagePaging } from "./useAgentConversationMessagePaging";

describe("useAgentConversationMessagePaging", () => {
  it("loads uncached detail through one combined reconcile", () => {
    const reconcileDetail = vi.fn();
    const { result } = renderHook(() =>
      useAgentConversationMessagePaging({
        diagnostics: { error: vi.fn(), page: vi.fn() },
        getActiveSessionId: () => "historical-session",
        getCanonicalMessages: () => [],
        isMounted: () => true,
        projection: {
          maxVersion: () => null,
          minVersion: () => null,
          windowHasTurnMissingUserPrompt: () => false
        },
        reload: {
          getActivationStatus: () => null,
          reconcileDetail,
          syncConversationList: vi.fn()
        },
        runtime: {} as AgentActivityRuntime,
        sessionViewRef: (agentSessionId) => ({
          agentSessionId,
          origin: "test",
          workspaceId: "workspace-1"
        }),
        view: {
          get: () => null,
          mergeOlder: vi.fn(),
          setOlderMessagesLoading: vi.fn()
        },
        workspaceId: "workspace-1"
      })
    );

    act(() => {
      void result.current.loadInitialMessages(" historical-session ");
    });

    expect(reconcileDetail).toHaveBeenCalledTimes(1);
    expect(reconcileDetail).toHaveBeenCalledWith("historical-session");
  });

  it("does not page older messages from a high mutable message version alone", async () => {
    const listSessionMessages = vi.fn();
    const setOlderMessagesLoading = vi.fn();
    const { result } = renderHook(() =>
      useAgentConversationMessagePaging({
        diagnostics: { error: vi.fn(), page: vi.fn() },
        getActiveSessionId: () => "new-session",
        getCanonicalMessages: () => [
          {
            agentSessionId: "new-session",
            kind: "text",
            messageId: "streamed-message",
            occurredAtUnixMs: 1,
            payload: {},
            role: "assistant",
            turnId: "turn-1",
            version: 446
          }
        ],
        isMounted: () => true,
        projection: {
          maxVersion: () => 446,
          minVersion: () => 446,
          windowHasTurnMissingUserPrompt: () => false
        },
        reload: {
          getActivationStatus: () => "confirmed",
          reconcileDetail: vi.fn(),
          syncConversationList: vi.fn()
        },
        runtime: { listSessionMessages } as unknown as AgentActivityRuntime,
        sessionViewRef: (agentSessionId) => ({
          agentSessionId,
          origin: "test",
          workspaceId: "workspace-1"
        }),
        view: {
          get: () => ({
            hasOlderMessages: false,
            isLoadingOlderMessages: false,
            olderMessages: [],
            oldestLoadedVersion: 446
          }),
          mergeOlder: vi.fn(),
          setOlderMessagesLoading
        },
        workspaceId: "workspace-1"
      })
    );

    await act(async () => {
      await result.current.loadOlderMessages("new-session");
    });

    expect(listSessionMessages).not.toHaveBeenCalled();
    expect(setOlderMessagesLoading).not.toHaveBeenCalled();
  });

  it("clears older-message loading after a successful page", async () => {
    const mergeOlder = vi.fn();
    const setOlderMessagesLoading = vi.fn();
    const pageDiagnostic = vi.fn();
    const listSessionMessages = vi.fn().mockResolvedValue({
      hasMore: false,
      latestVersion: 278,
      messages: []
    });
    const { result } = renderHook(() =>
      useAgentConversationMessagePaging({
        diagnostics: { error: vi.fn(), page: pageDiagnostic },
        getActiveSessionId: () => "historical-session",
        getCanonicalMessages: () => [],
        isMounted: () => true,
        projection: {
          maxVersion: () => null,
          minVersion: () => 446,
          windowHasTurnMissingUserPrompt: () => false
        },
        reload: {
          getActivationStatus: () => null,
          reconcileDetail: vi.fn(),
          syncConversationList: vi.fn()
        },
        runtime: { listSessionMessages } as unknown as AgentActivityRuntime,
        sessionViewRef: (agentSessionId) => ({
          agentSessionId,
          origin: "test",
          workspaceId: "workspace-1"
        }),
        view: {
          get: () => ({
            hasOlderMessages: true,
            isLoadingOlderMessages: false,
            olderMessages: [],
            oldestLoadedVersion: 446
          }),
          mergeOlder,
          setOlderMessagesLoading
        },
        workspaceId: "workspace-1"
      })
    );

    await act(async () => {
      await result.current.loadOlderMessages("historical-session");
    });

    expect(listSessionMessages).toHaveBeenCalledWith({
      agentSessionId: "historical-session",
      beforeVersion: 446,
      cache: false,
      limit: 100,
      order: "desc",
      workspaceId: "workspace-1"
    });
    expect(mergeOlder).toHaveBeenCalledWith(
      {
        agentSessionId: "historical-session",
        origin: "test",
        workspaceId: "workspace-1"
      },
      [],
      { hasOlderMessages: false, oldestLoadedVersion: 446 }
    );
    expect(setOlderMessagesLoading.mock.calls).toEqual([
      [
        {
          agentSessionId: "historical-session",
          origin: "test",
          workspaceId: "workspace-1"
        },
        true
      ],
      [
        {
          agentSessionId: "historical-session",
          origin: "test",
          workspaceId: "workspace-1"
        },
        false
      ]
    ]);

    await act(async () => {
      await result.current.loadOlderMessages("historical-session");
    });

    expect(listSessionMessages).toHaveBeenCalledTimes(1);
    expect(pageDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionId: "historical-session",
        details: { beforeVersion: 446, reason: "exhausted_cursor" },
        event: "agent.gui.messages.older.suppressed_exhausted_cursor"
      })
    );
  });

  it("keeps a non-empty terminal page authoritative after the cursor advances", async () => {
    let oldestLoadedVersion = 446;
    let hasOlderMessages = true;
    const listSessionMessages = vi.fn().mockResolvedValue({
      hasMore: false,
      latestVersion: 445,
      messages: [
        {
          agentSessionId: "historical-session",
          kind: "text",
          messageId: "message-1",
          occurredAtUnixMs: 1,
          payload: {},
          role: "assistant",
          turnId: "turn-1",
          version: 1
        }
      ]
    });
    const { result } = renderHook(() =>
      useAgentConversationMessagePaging({
        diagnostics: { error: vi.fn(), page: vi.fn() },
        getActiveSessionId: () => "historical-session",
        getCanonicalMessages: () => [],
        isMounted: () => true,
        projection: {
          maxVersion: () => null,
          minVersion: () => 446,
          windowHasTurnMissingUserPrompt: () => false
        },
        reload: {
          getActivationStatus: () => null,
          reconcileDetail: vi.fn(),
          syncConversationList: vi.fn()
        },
        runtime: { listSessionMessages } as unknown as AgentActivityRuntime,
        sessionViewRef: (agentSessionId) => ({
          agentSessionId,
          origin: "test",
          workspaceId: "workspace-1"
        }),
        view: {
          get: () => ({
            hasOlderMessages,
            isLoadingOlderMessages: false,
            olderMessages: [],
            oldestLoadedVersion
          }),
          mergeOlder: (_ref, messages, options) => {
            oldestLoadedVersion = Math.min(
              oldestLoadedVersion,
              ...messages.map((message) => message.version)
            );
            hasOlderMessages = options?.hasOlderMessages ?? hasOlderMessages;
          },
          setOlderMessagesLoading: vi.fn()
        },
        workspaceId: "workspace-1"
      })
    );

    await act(async () => {
      await result.current.loadOlderMessages("historical-session");
      await result.current.loadOlderMessages("historical-session");
    });

    expect(oldestLoadedVersion).toBe(1);
    expect(hasOlderMessages).toBe(false);
    expect(listSessionMessages).toHaveBeenCalledTimes(1);
  });
});
