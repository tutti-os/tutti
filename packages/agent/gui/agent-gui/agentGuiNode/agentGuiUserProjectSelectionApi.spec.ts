import { describe, expect, it, vi } from "vitest";
import type { AgentHostUserProjectsApi } from "../../host/agentHostApi";
import { createAgentGUIUserProjectSelectionApi } from "./agentGuiUserProjectSelectionApi";

function createUserProjectsApi(): AgentHostUserProjectsApi {
  return {
    async list() {
      return { projects: [] };
    },
    async pin() {},
    async use({ path }) {
      return { id: path, label: path, path, pinnedAtUnixMs: 0 };
    }
  };
}

describe("createAgentGUIUserProjectSelectionApi", () => {
  it("uses only the explicitly injected project directory selector", async () => {
    const selectProjectDirectory = vi.fn(async () => ({
      path: "/workspace/existing"
    }));
    const api = createAgentGUIUserProjectSelectionApi({
      selectProjectDirectory,
      userProjects: createUserProjectsApi()
    });

    await expect(api?.selectDirectory?.()).resolves.toEqual({
      path: "/workspace/existing"
    });
    expect(selectProjectDirectory).toHaveBeenCalledOnce();
  });

  it("disables existing-project selection when the selector is unavailable", () => {
    const api = createAgentGUIUserProjectSelectionApi({
      selectProjectDirectory: undefined,
      userProjects: createUserProjectsApi()
    });

    expect(api?.selectDirectory).toBeUndefined();
  });

  it("adds the optional import flow without changing the default project API", async () => {
    const importDirectory = vi.fn(async () => ({
      path: "/workspace/imported"
    }));
    const api = createAgentGUIUserProjectSelectionApi({
      importDirectory,
      userProjects: createUserProjectsApi()
    });

    await expect(api?.importDirectory?.()).resolves.toEqual({
      path: "/workspace/imported"
    });
    expect(api?.selectDirectory).toBeUndefined();
  });

  it("does not fabricate a project catalog for a directory-only host", () => {
    const selectProjectDirectory = vi.fn(async () => ({
      path: "/workspace/existing"
    }));
    const api = createAgentGUIUserProjectSelectionApi({
      selectProjectDirectory,
      userProjects: null
    });

    expect(api).toBeNull();
    expect(selectProjectDirectory).not.toHaveBeenCalled();
  });
});
