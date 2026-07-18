import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAgentGUIConversationMetadataActions } from "./useAgentGUIConversationMetadataActions";

describe("useAgentGUIConversationMetadataActions project pin", () => {
  it("delegates to the shared user-project store and diagnoses failures silently", async () => {
    const pin = vi.fn(() => Promise.reject(new Error("pin failed")));
    const logRuntimeDiagnostics = vi.fn();
    const toastError = vi.fn();
    const setUserProjectsSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUIConversationMetadataActions({
        agentActivityRuntime: {} as never,
        agentHostApi: {
          debug: { logRuntimeDiagnostics },
          toast: { error: toastError },
          userProjects: { pin }
        } as never,
        currentUserId: "user-1",
        dataRef: { current: { provider: "codex" } } as never,
        sessionEngine: {} as never,
        setDetailError: vi.fn(),
        setListError: vi.fn(),
        setUserProjectsSnapshot,
        userProjectsRef: { current: [] },
        workspaceId: "workspace-1"
      })
    );

    await act(async () => {
      await result.current.toggleProjectPinned(" project-1 ", true);
    });

    expect(pin).toHaveBeenCalledWith({
      pinned: true,
      projectId: "project-1"
    });
    expect(logRuntimeDiagnostics).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "pin_user_project_failed",
        pinned: true,
        projectId: "project-1"
      })
    );
    expect(setUserProjectsSnapshot).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
