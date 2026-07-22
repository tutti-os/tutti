import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { AgentActivityHostProvider } from "../../agentActivityHost";
import type { AgentHostInputApi } from "../../host/agentHostApi";
import { AgentProjectDropdown } from "./AgentComposerProjectMenu";

describe("AgentProjectDropdown project selection intent", () => {
  it("keeps an explicitly unscoped home composer instead of restoring the default project", async () => {
    const defaultProject = {
      id: "project-alpha",
      label: "Alpha",
      path: "/workspace/alpha",
      pinnedAtUnixMs: 0
    };
    const getDefaultSelection = vi.fn(async () => ({
      path: defaultProject.path
    }));
    const onProjectPathChange = vi.fn();

    render(
      <AgentActivityHostProvider
        agentHostApi={createAgentHostApi({
          getDefaultSelection,
          list: async () => ({ projects: [defaultProject] })
        })}
      >
        <AgentProjectDropdown
          composerSettings={{
            projectLocked: false,
            selectedProjectPath: null,
            shouldApplyPreparedProjectSelection: false
          }}
          i18n={createDefaultWorkspaceUserProjectI18nRuntime()}
          labels={{
            projectLocked: "Project locked",
            projectMissingDescription: "Project missing"
          }}
          onProjectPathChange={onProjectPathChange}
        />
      </AgentActivityHostProvider>
    );

    await waitFor(() => expect(getDefaultSelection).toHaveBeenCalledTimes(1));
    expect(onProjectPathChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveTextContent("No project");
  });
});

function createAgentHostApi(
  userProjects: Pick<
    NonNullable<AgentHostInputApi["userProjects"]>,
    "getDefaultSelection" | "list"
  >
): AgentHostInputApi {
  return {
    clipboard: {
      writeText: async () => {}
    },
    filesystem: {
      readFileText: async () => ({ content: "" })
    },
    userProjects: {
      ...userProjects,
      pin: async () => {},
      use: async ({ path }) => ({
        id: path,
        label: path,
        path,
        pinnedAtUnixMs: 0
      })
    },
    workspace: {
      ensureDirectory: async () => {},
      readFile: async () => ({ bytes: new Uint8Array() }),
      selectDirectory: async () => null,
      selectFiles: async () => [],
      writeFileText: async () => {}
    }
  };
}
