import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { AgentActivityRuntime } from "../../../agentActivityRuntime";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { useAgentGUIConversationDeletion } from "./useAgentGUIConversationDeletion";

const targetConversation: AgentGUIConversationSummary = {
  cwd: "/workspace",
  id: "session-1",
  provider: "codex",
  sortTimeUnixMs: 2,
  status: "completed",
  title: "Session 1",
  titleFallback: null,
  updatedAtUnixMs: 2,
  userId: "user-1"
};

const nextConversation: AgentGUIConversationSummary = {
  ...targetConversation,
  id: "session-2",
  sortTimeUnixMs: 1,
  title: "Session 2",
  updatedAtUnixMs: 1
};

function createInput(agentActivityRuntime: AgentActivityRuntime) {
  const activeConversationIdRef = { current: targetConversation.id };
  const unactivate = vi.fn(async () => {});
  const toastError = vi.fn();
  const input = {
    activeConversationIdRef,
    activation: { unactivate } as never,
    agentActivityRuntime,
    agentHostApi: { toast: { error: toastError } } as never,
    conversations: [targetConversation, nextConversation],
    deleteAgentSessionView: vi.fn(),
    isDeletingConversation: false,
    pendingDeleteConversation: targetConversation,
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
    setIsDeletingConversation: vi.fn(),
    setIsLoadingMessages: vi.fn(),
    setPendingDeleteConversation: vi.fn(),
    submittedDraftSnapshotsRef: { current: {} },
    workspaceId: "workspace-1"
  };
  return { input, toastError, unactivate };
}

describe("useAgentGUIConversationDeletion", () => {
  it("returns home before deleting the active session", async () => {
    let committedActiveConversationId: string | null = targetConversation.id;
    let activeConversationIdObservedByDelete: string | null = null;
    const deleteSession = vi.fn(async () => {
      activeConversationIdObservedByDelete = committedActiveConversationId;
      return {
        cleanupFailed: false,
        removed: true,
        removedMessages: 0
      };
    });
    const { input, unactivate } = createInput({
      deleteSession
    } as unknown as AgentActivityRuntime);
    const { result } = renderHook(() => {
      const [activeConversationId, setActiveConversationId] = useState<
        string | null
      >(targetConversation.id);
      committedActiveConversationId = activeConversationId;
      return {
        activeConversationId,
        ...useAgentGUIConversationDeletion({
          ...input,
          setActiveConversationId
        })
      };
    });

    act(() => result.current.confirmDeleteConversation());

    expect(result.current.activeConversationId).toBeNull();
    expect(input.persistActiveConversation).toHaveBeenCalledWith(null);
    expect(input.setIntent).toHaveBeenCalledWith({ tag: "home" });
    expect(input.setIsLoadingMessages).toHaveBeenCalledWith(false);
    expect(unactivate).toHaveBeenCalledWith(targetConversation.id);
    await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));
    expect(activeConversationIdObservedByDelete).toBeNull();
    expect(deleteSession).toHaveBeenCalledWith({
      agentSessionId: targetConversation.id,
      workspaceId: "workspace-1"
    });
    await waitFor(() =>
      expect(input.deleteAgentSessionView).toHaveBeenCalledTimes(1)
    );
    expect(input.removeConversations).toHaveBeenCalledWith([
      targetConversation.id
    ]);
  });

  it("keeps the committed home selection when deletion fails", async () => {
    const deleteSession = vi.fn(async () => {
      throw new Error("delete failed");
    });
    const { input, toastError } = createInput({
      deleteSession
    } as unknown as AgentActivityRuntime);
    const { result } = renderHook(() => {
      const [activeConversationId, setActiveConversationId] = useState<
        string | null
      >(targetConversation.id);
      return {
        activeConversationId,
        ...useAgentGUIConversationDeletion({
          ...input,
          setActiveConversationId
        })
      };
    });

    act(() => result.current.confirmDeleteConversation());

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(result.current.activeConversationId).toBeNull();
    expect(input.activeConversationIdRef.current).toBeNull();
    expect(input.deleteAgentSessionView).not.toHaveBeenCalled();
    expect(input.removeConversations).not.toHaveBeenCalled();
    expect(input.setIsDeletingConversation).toHaveBeenLastCalledWith(false);
  });
});
