import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { translate } from "../../../i18n/index";
import { useAgentGUIConversationMetadataActions } from "./useAgentGUIConversationMetadataActions";

const dispatchSessionForkThroughTurn = vi.hoisted(() => vi.fn());

vi.mock("@tutti-os/agent-activity-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tutti-os/agent-activity-core")>();
  return { ...actual, dispatchSessionForkThroughTurn };
});

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

describe("useAgentGUIConversationMetadataActions project removal", () => {
  it("waits for the authoritative removal before changing the local snapshot", async () => {
    let finishRemoval!: () => void;
    const remove = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        })
    );
    const setUserProjectsSnapshot = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUIConversationMetadataActions({
        agentActivityRuntime: {} as never,
        agentHostApi: {
          toast: { error: vi.fn() },
          userProjects: { remove }
        } as never,
        currentUserId: "user-1",
        dataRef: { current: { provider: "codex" } } as never,
        sessionEngine: {} as never,
        setDetailError: vi.fn(),
        setListError: vi.fn(),
        setUserProjectsSnapshot,
        userProjectsRef: {
          current: [
            { id: "remove", path: "/workspace/remove" },
            { id: "keep", path: "/workspace/keep" }
          ]
        } as never,
        workspaceId: "workspace-1"
      })
    );

    let removal!: Promise<boolean>;
    act(() => {
      removal = result.current.removeProject("/workspace/remove");
    });
    expect(setUserProjectsSnapshot).not.toHaveBeenCalled();
    finishRemoval();
    await expect(removal).resolves.toBe(true);
    expect(setUserProjectsSnapshot).toHaveBeenCalledWith([
      expect.objectContaining({ id: "keep" })
    ]);
  });
});

describe("useAgentGUIConversationMetadataActions fork identity", () => {
  it("leaves identity reuse to the Engine facade and selects its authoritative target", async () => {
    const unsupported = Object.assign(new Error("unsupported"), {
      code: "agent_session_fork_unsupported"
    });
    const selectConversation = vi.fn();
    dispatchSessionForkThroughTurn
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValueOnce({
        status: "succeeded",
        targetAgentSessionId: "session-authoritative-child"
      });
    const { result } = renderHook(() =>
      useAgentGUIConversationMetadataActions({
        agentActivityRuntime: {} as never,
        agentHostApi: {
          debug: { logRuntimeDiagnostics: vi.fn() },
          toast: { error: vi.fn() }
        } as never,
        currentUserId: "user-1",
        dataRef: { current: { provider: "codex" } } as never,
        sessionEngine: {} as never,
        setDetailError: vi.fn(),
        setListError: vi.fn(),
        setUserProjectsSnapshot: vi.fn(),
        userProjectsRef: { current: [] },
        workspaceId: "workspace-1",
        selectConversation
      })
    );

    await act(async () => {
      await result.current.forkConversationThroughTurn(
        "session-source",
        "turn-1"
      );
      await result.current.forkConversationThroughTurn(
        "session-source",
        "turn-1"
      );
    });

    expect(dispatchSessionForkThroughTurn).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      {
        sourceAgentSessionId: "session-source",
        turnId: "turn-1",
        workspaceId: "workspace-1"
      }
    );
    expect(dispatchSessionForkThroughTurn).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      {
        sourceAgentSessionId: "session-source",
        turnId: "turn-1",
        workspaceId: "workspace-1"
      }
    );
    expect(selectConversation).toHaveBeenCalledWith(
      "session-authoritative-child"
    );
  });
});

describe("useAgentGUIConversationMetadataActions fork lineage navigation", () => {
  it("resolves the exact source Session before selecting it", async () => {
    const getSession = vi.fn().mockResolvedValue({
      agentSessionId: "session-source"
    });
    const selectConversation = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUIConversationMetadataActions({
        agentActivityRuntime: { getSession } as never,
        agentHostApi: {
          toast: { error: vi.fn() }
        } as never,
        currentUserId: "user-1",
        dataRef: { current: { provider: "codex" } } as never,
        sessionEngine: {} as never,
        setDetailError: vi.fn(),
        setListError: vi.fn(),
        setUserProjectsSnapshot: vi.fn(),
        userProjectsRef: { current: [] },
        workspaceId: "workspace-1",
        selectConversation
      })
    );

    await act(async () => {
      await result.current.openForkSourceConversation(" session-source ");
    });

    expect(getSession).toHaveBeenCalledWith("workspace-1", "session-source");
    expect(selectConversation).toHaveBeenCalledWith("session-source");
  });

  it("reports a missing source only after the lookup fails", async () => {
    const missingSource = {
      code: "workspace_not_found",
      reason: "workspace_agent_session_not_found",
      statusCode: 404
    };
    const getSession = vi.fn().mockRejectedValue(missingSource);
    const selectConversation = vi.fn();
    const toastError = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUIConversationMetadataActions({
        agentActivityRuntime: { getSession } as never,
        agentHostApi: {
          toast: { error: toastError }
        } as never,
        currentUserId: "user-1",
        dataRef: { current: { provider: "codex" } } as never,
        sessionEngine: {} as never,
        setDetailError: vi.fn(),
        setListError: vi.fn(),
        setUserProjectsSnapshot: vi.fn(),
        userProjectsRef: { current: [] },
        workspaceId: "workspace-1",
        selectConversation
      })
    );

    await act(async () => {
      await result.current.openForkSourceConversation("missing-source-session");
    });

    expect(selectConversation).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      translate("agentHost.agentGui.sourceConversationNotFound")
    );
  });
});
