import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetAgentHostApiForTests,
  setAgentHostApiForTests
} from "../../../agentActivityHost";
import type { AgentHostRuntimeApi } from "../../../host/agentHostApi";
import { useSessionWorktreeLaunch } from "./useSessionWorktreeLaunch";

afterEach(() => {
  resetAgentHostApiForTests();
});

describe("useSessionWorktreeLaunch", () => {
  it("shows the remembered worktree mode only after exact local support resolves", async () => {
    const resolveSupport = vi.fn(async () => ({
      supported: true,
      root: "/workspace"
    }));
    setAgentHostApiForTests({
      workspace: { resolveSessionWorktreeSupport: resolveSupport }
    } as unknown as AgentHostRuntimeApi);

    const onModeChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionWorktreeLaunch({
        enabled: true,
        mode: "worktree",
        onModeChange,
        projectSectionKey: "project:/workspace",
        selectedAgentTarget: {
          targetId: "local:codex",
          agentTargetId: "local:codex",
          label: "Codex",
          ownership: "self",
          provider: "codex",
          ref: { kind: "local", provider: "codex" }
        },
        selectedProjectPath: "/workspace"
      })
    );

    expect(result.current.visible).toBe(false);
    expect(result.current.mode).toBe("local");
    await waitFor(() => expect(result.current.visible).toBe(true));
    expect(result.current.mode).toBe("worktree");
    expect(resolveSupport).toHaveBeenCalledWith({
      agentTargetId: "local:codex",
      cwd: "/workspace"
    });

    act(() => result.current.onModeChange("local"));
    expect(onModeChange).toHaveBeenCalledWith("local");
  });

  it("hides the control for shared agents without probing or mutating preference", () => {
    const resolveSupport = vi.fn(async () => ({ supported: true }));
    setAgentHostApiForTests({
      workspace: { resolveSessionWorktreeSupport: resolveSupport }
    } as unknown as AgentHostRuntimeApi);
    const onModeChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionWorktreeLaunch({
        enabled: true,
        mode: "worktree",
        onModeChange,
        projectSectionKey: "project:/workspace",
        selectedAgentTarget: {
          targetId: "shared:codex",
          agentTargetId: "shared:codex",
          label: "Shared Codex",
          ownership: "shared",
          provider: "codex",
          ref: { kind: "shared", provider: "codex" }
        },
        selectedProjectPath: "/workspace"
      })
    );

    expect(result.current).toMatchObject({ visible: false, mode: "local" });
    act(() => result.current.onModeChange("local"));
    expect(resolveSupport).not.toHaveBeenCalled();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("falls back locally without overwriting a remembered mode when support is unavailable", async () => {
    const resolveSupport = vi.fn(async () => ({ supported: false }));
    setAgentHostApiForTests({
      workspace: { resolveSessionWorktreeSupport: resolveSupport }
    } as unknown as AgentHostRuntimeApi);
    const onModeChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionWorktreeLaunch({
        enabled: true,
        mode: "worktree",
        onModeChange,
        projectSectionKey: "project:/workspace",
        selectedAgentTarget: {
          targetId: "local:codex",
          agentTargetId: "local:codex",
          label: "Codex",
          ownership: "self",
          provider: "codex",
          ref: { kind: "local", provider: "codex" }
        },
        selectedProjectPath: "/workspace"
      })
    );

    await waitFor(() => expect(resolveSupport).toHaveBeenCalledOnce());
    expect(result.current).toMatchObject({ visible: false, mode: "local" });
    act(() => result.current.onModeChange("local"));
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it("does not probe or mutate launch preference for an existing Session", () => {
    const resolveSupport = vi.fn(async () => ({ supported: true }));
    setAgentHostApiForTests({
      workspace: { resolveSessionWorktreeSupport: resolveSupport }
    } as unknown as AgentHostRuntimeApi);
    const onModeChange = vi.fn();
    const { result } = renderHook(() =>
      useSessionWorktreeLaunch({
        agentSessionId: "session-1",
        enabled: true,
        mode: "worktree",
        onModeChange,
        projectSectionKey: "project:/workspace",
        selectedAgentTarget: {
          targetId: "local:codex",
          agentTargetId: "local:codex",
          label: "Codex",
          ownership: "self",
          provider: "codex",
          ref: { kind: "local", provider: "codex" }
        },
        selectedProjectPath: "/workspace"
      })
    );

    expect(result.current).toMatchObject({ visible: false, mode: "local" });
    act(() => result.current.onModeChange("local"));
    expect(resolveSupport).not.toHaveBeenCalled();
    expect(onModeChange).not.toHaveBeenCalled();
  });
});
