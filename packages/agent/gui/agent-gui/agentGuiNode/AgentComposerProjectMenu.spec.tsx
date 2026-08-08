import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
import { AgentGUIActivityHostProvider } from "../../agentActivityHost";
import type { AgentHostInputApi } from "../../host/agentHostApi";
import { AgentProjectDropdown } from "./AgentComposerProjectMenu";

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
  });
});

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
      <AgentGUIActivityHostProvider
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
      </AgentGUIActivityHostProvider>
    );

    await waitFor(() => expect(getDefaultSelection).toHaveBeenCalledTimes(1));
    expect(onProjectPathChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveTextContent("No project");
  });
});

describe("WorkspaceUserProjectSelect render budget", () => {
  it("does not construct project action content while closed", async () => {
    const renderAddProjectIcon = vi.fn(() => <span aria-hidden />);
    const alphaProject = {
      id: "project-alpha",
      label: "Alpha",
      path: "/workspace/alpha",
      pinnedAtUnixMs: 0
    };
    const betaProject = {
      id: "project-beta",
      label: "Beta",
      path: "/workspace/beta",
      pinnedAtUnixMs: 0
    };
    const onProjectPathChange = vi.fn();

    render(
      <WorkspaceUserProjectSelect
        api={{
          create: async () => alphaProject,
          list: async () => ({ projects: [alphaProject, betaProject] })
        }}
        renderAddProjectIcon={renderAddProjectIcon}
        selectedProjectPath={alphaProject.path}
        shouldApplyPreparedSelection={false}
        onProjectPathChange={onProjectPathChange}
      />
    );

    const trigger = await screen.findByRole("combobox", { name: "Project" });
    expect(renderAddProjectIcon).not.toHaveBeenCalled();

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });

    const betaOption = await screen.findByRole("option", { name: "Beta" });
    expect(renderAddProjectIcon).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(betaOption, { button: 0, ctrlKey: false });
    fireEvent.click(betaOption);

    expect(onProjectPathChange).toHaveBeenCalledWith(betaProject.path, {
      action: "select_existing"
    });
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "Beta" })).toBeNull()
    );
  });

  it("prepares once for the controlled path after an external project is linked", async () => {
    const project = {
      id: "project-alpha",
      label: "Alpha",
      path: "/workspace/alpha",
      pinnedAtUnixMs: 0
    };
    const linkedProject = {
      id: "project-beta",
      label: "Beta",
      path: "/workspace/beta",
      pinnedAtUnixMs: 0
    };
    const prepareSelection = vi.fn(async () => ({
      isSelectedPathMissing: false,
      projects: [project],
      selection: { kind: "none" as const }
    }));
    const useProject = vi.fn(async () => linkedProject);
    const api = {
      list: async () => ({ projects: [project] }),
      prepareSelection,
      selectDirectory: vi.fn(async () => ({ path: linkedProject.path })),
      use: useProject
    };

    function ControlledSelect() {
      const [path, setPath] = useState<string | null>(null);
      return (
        <WorkspaceUserProjectSelect
          api={api}
          selectedProjectPath={path}
          shouldApplyPreparedSelection={false}
          onProjectPathChange={setPath}
        />
      );
    }

    render(<ControlledSelect />);
    const trigger = await screen.findByRole("combobox", { name: "Project" });
    await waitFor(() => expect(prepareSelection).toHaveBeenCalledTimes(1));

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse"
    });
    const option = await screen.findByRole("option", {
      name: "Use existing project"
    });
    fireEvent.pointerDown(option, { button: 0, ctrlKey: false });
    fireEvent.click(option);

    await waitFor(() => expect(useProject).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(prepareSelection).toHaveBeenCalledTimes(2));
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
