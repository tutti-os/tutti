import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import { useAgentGUIConversationBatchDeletion } from "./useAgentGUIConversationBatchDeletion";

function createInput(agentActivityRuntime: AgentActivityRuntime) {
  return {
    activeConversationIdRef: { current: null as string | null },
    agentActivityRuntime,
    agentHostApi: { toast: { error: vi.fn() } } as never,
    conversationsRef: {
      current: [
        {
          cwd: "/workspace",
          id: "loaded-session",
          provider: "codex" as const,
          sortTimeUnixMs: 1,
          status: "completed" as const,
          title: "Loaded",
          titleFallback: null,
          updatedAtUnixMs: 1,
          userId: "user-1"
        }
      ]
    },
    dataRef: { current: { provider: "codex" } } as never,
    deleteAgentSessionView: vi.fn(),
    isDeletingProjectConversations: false,
    markSelectedConversationDetailPending: vi.fn(() => null),
    persistActiveConversation: vi.fn(),
    removeConversations: vi.fn(),
    sessionViewRef: (agentSessionId: string | null | undefined) => ({
      agentSessionId,
      origin: "local",
      workspaceId: "workspace-1"
    }),
    setActiveConversationId: vi.fn(),
    setDetailError: vi.fn(),
    setDraftByScopeKey: vi.fn(),
    setIntent: vi.fn(),
    setIsDeletingProjectConversations: vi.fn(),
    setIsLoadingMessages: vi.fn(),
    setListError: vi.fn(),
    submittedDraftSnapshotsRef: { current: {} },
    workspaceId: "workspace-1"
  };
}

describe("useAgentGUIConversationBatchDeletion", () => {
  it("requests one unpinned candidate snapshot and sends one exact batch delete", async () => {
    const listSessionSectionDeletionCandidates = vi.fn(async () => ({
      excludePinned: true,
      sectionKey: "conversations",
      sessionIds: ["loaded-session", "unloaded-session"],
      workspaceId: "workspace-1"
    }));
    const deleteSessionsBatch = vi.fn(async () => ({
      cleanupFailedSessionIds: [],
      removedMessages: 1,
      removedSessionIds: ["loaded-session", "unloaded-session"],
      removedSessions: 2
    }));
    const deleteSession = vi.fn();
    const runtime = {
      deleteSession,
      deleteSessionsBatch,
      listSessionSectionDeletionCandidates
    } as unknown as AgentActivityRuntime;
    const input = createInput(runtime);
    const { result } = renderHook(() =>
      useAgentGUIConversationBatchDeletion(input)
    );

    let sessionIds: string[] = [];
    await act(async () => {
      sessionIds = await result.current.confirmDeleteProjectConversations(
        "conversations",
        "codex-target"
      );
    });
    expect(listSessionSectionDeletionCandidates).toHaveBeenCalledTimes(1);
    expect(listSessionSectionDeletionCandidates).toHaveBeenCalledWith({
      agentTargetId: "codex-target",
      excludePinned: true,
      sectionKey: "conversations",
      workspaceId: "workspace-1"
    });

    act(() => result.current.confirmDeleteConversations(sessionIds));
    await waitFor(() => expect(deleteSessionsBatch).toHaveBeenCalledTimes(1));
    expect(deleteSessionsBatch).toHaveBeenCalledWith({
      sessionIds: ["loaded-session", "unloaded-session"],
      workspaceId: "workspace-1"
    });
    expect(deleteSession).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(input.deleteAgentSessionView).toHaveBeenCalledTimes(2)
    );
    expect(input.removeConversations).toHaveBeenCalledWith([
      "loaded-session",
      "unloaded-session"
    ]);
  });

  it("refreshes activity and does not delete when the candidate snapshot is empty", async () => {
    const load = vi.fn(async () => ({
      presences: [],
      sessionMessagesById: {},
      sessions: [],
      workspaceId: "workspace-1"
    }));
    const runtime = {
      deleteSessionsBatch: vi.fn(),
      listSessionSectionDeletionCandidates: vi.fn(async () => ({
        excludePinned: true,
        sectionKey: "conversations",
        sessionIds: [],
        workspaceId: "workspace-1"
      })),
      load
    } as unknown as AgentActivityRuntime;
    const { result } = renderHook(() =>
      useAgentGUIConversationBatchDeletion(createInput(runtime))
    );

    let sessionIds: string[] = [];
    await act(async () => {
      sessionIds =
        await result.current.confirmDeleteProjectConversations("conversations");
    });

    expect(sessionIds).toEqual([]);
    await waitFor(() => expect(load).toHaveBeenCalledWith("workspace-1"));
    expect(runtime.deleteSessionsBatch).not.toHaveBeenCalled();
  });

  it("commits a surviving conversation before deleting a batch containing the active session", async () => {
    let committedActiveConversationId: string | null = "loaded-session";
    let activeConversationIdObservedByDelete: string | null = null;
    const deleteSessionsBatch = vi.fn(async () => {
      activeConversationIdObservedByDelete = committedActiveConversationId;
      return {
        cleanupFailedSessionIds: [],
        removedMessages: 0,
        removedSessionIds: ["loaded-session"],
        removedSessions: 1
      };
    });
    const runtime = {
      deleteSession: vi.fn(),
      deleteSessionsBatch
    } as unknown as AgentActivityRuntime;
    const input = createInput(runtime);
    input.activeConversationIdRef.current = "loaded-session";
    input.conversationsRef.current = [
      ...input.conversationsRef.current,
      {
        cwd: "/workspace",
        id: "surviving-session",
        provider: "codex" as const,
        sortTimeUnixMs: 2,
        status: "completed" as const,
        title: "Surviving",
        titleFallback: null,
        updatedAtUnixMs: 2,
        userId: "user-1"
      }
    ];
    const { result } = renderHook(() => {
      const [activeConversationId, setActiveConversationId] = useState<
        string | null
      >("loaded-session");
      committedActiveConversationId = activeConversationId;
      return {
        activeConversationId,
        ...useAgentGUIConversationBatchDeletion({
          ...input,
          setActiveConversationId
        })
      };
    });

    act(() => result.current.confirmDeleteConversations(["loaded-session"]));

    expect(result.current.activeConversationId).toBe("surviving-session");
    expect(activeConversationIdObservedByDelete).toBe("surviving-session");
    expect(input.persistActiveConversation).toHaveBeenCalledWith(
      "surviving-session"
    );
    await waitFor(() =>
      expect(input.deleteAgentSessionView).toHaveBeenCalledTimes(1)
    );
  });
});
