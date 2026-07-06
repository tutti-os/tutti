import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import type { WorkspaceUserProjectService } from "@tutti-os/workspace-user-project/contracts";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { proxy } from "valtio/vanilla";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentModelReasoningDropdown,
  AgentPermissionModeDropdown,
  AgentProjectDropdown
} from "./AgentComposerSettingsMenus";
import type { AgentGUIComposerSettingsVM } from "./model/agentGuiNodeTypes";

const { mockAgentHostApi } = vi.hoisted(() => ({
  mockAgentHostApi: {
    userProjects: undefined,
    workspace: {
      selectDirectory: vi.fn()
    }
  } as {
    userProjects:
      | undefined
      | {
          checkPath?: ReturnType<typeof vi.fn>;
          create?: ReturnType<typeof vi.fn>;
          getDefaultSelection?: ReturnType<typeof vi.fn>;
          isNoProjectPath?: ReturnType<typeof vi.fn>;
          list: ReturnType<typeof vi.fn>;
          rememberDefaultSelection?: ReturnType<typeof vi.fn>;
          selectDirectory?: ReturnType<typeof vi.fn>;
          service?: WorkspaceUserProjectService;
          subscribe?: ReturnType<typeof vi.fn>;
          use: ReturnType<typeof vi.fn>;
        };
    workspace: {
      selectDirectory: ReturnType<typeof vi.fn>;
    };
  }
}));

const workspaceUserProjectI18n = createDefaultWorkspaceUserProjectI18nRuntime();

vi.mock("../../agentActivityHost", () => ({
  useAgentHostApi: () => mockAgentHostApi
}));

afterEach(() => {
  vi.clearAllMocks();
  mockAgentHostApi.userProjects = undefined;
  mockAgentHostApi.workspace.selectDirectory.mockReset();
});

describe("AgentProjectDropdown", () => {
  it("renders the project trigger without the folder icon", async () => {
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: []
      }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    const trigger = screen.getByRole("combobox", { name: "Project" });
    expect(trigger).toHaveTextContent("No project");
    expect(trigger).toHaveClass("text-[var(--agent-gui-text-tertiary)]");
    expect(trigger.querySelector(".lucide-folder")).toBeNull();
  });

  it("shows unlocked no-project workspace roots as No project", async () => {
    const noProjectPath = "/workspace/workspace-1";
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: []
      }),
      isNoProjectPath: vi.fn(({ path }) => path === noProjectPath),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: noProjectPath,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    const trigger = screen.getByRole("combobox", { name: "Project" });
    expect(trigger).toHaveTextContent("No project");
    expect(trigger.querySelector(".lucide-folder")).toBeNull();
    expect(mockAgentHostApi.userProjects.isNoProjectPath).toHaveBeenCalledWith({
      path: noProjectPath
    });
  });

  it("opens the project folder menu through ui-system Select layering", async () => {
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/tutti",
            label: "tutti"
          }
        ]
      }),
      checkPath: vi.fn().mockResolvedValue({
        exists: false,
        isDirectory: false,
        path: "/workspace/deleted"
      }),
      create: vi.fn(),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    const trigger = screen.getByRole("combobox", { name: "Project" });
    ensurePointerCaptureApi();
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    const projectOption = await screen.findByRole("option", {
      name: /tutti/
    });
    expect(projectOption.closest('[data-slot="select-content"]')).toHaveClass(
      "data-[side=top]:!translate-y-0"
    );
    expect(projectOption).toBeVisible();
    expect(
      projectOption.querySelector(
        '[data-workspace-user-project-overflow-label="true"]'
      )
    ).not.toBeNull();
    expect(projectOption).toHaveTextContent("tutti");
    expect(projectOption).not.toHaveTextContent("/workspace/tutti");
    const noProjectOption = screen.getByRole("option", {
      name: "No project"
    });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "tutti",
      "Use existing project",
      "Add project",
      "No project"
    ]);
    const addProjectOption = screen.getByRole("option", {
      name: "Add project"
    });
    expect(
      addProjectOption.querySelector(
        '[data-workspace-user-project-add-icon="true"]'
      )
    ).not.toBeNull();
    expect(
      noProjectOption.querySelector(
        '[data-agent-project-no-workspace-icon="true"]'
      )
    ).not.toBeNull();
    const content = document.querySelector<HTMLElement>(
      '[data-slot="select-content"]'
    );
    expect(content).toHaveStyle({ zIndex: "var(--z-popover)" });
    expect(content?.className).toContain("w-[240px]");
    expect(content?.className).toContain("min-w-[240px]");
  });

  it("hides absolute paths from project labels returned by the host", async () => {
    const privateProjectPath = "/Users/local/Documents/Private Project";
    const windowsProjectPath = "C:\\Users\\local\\Documents\\Windows Project";
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: privateProjectPath,
            label: `Private Project / ${privateProjectPath}`
          },
          {
            id: "dir-2",
            path: windowsProjectPath,
            label: windowsProjectPath
          }
        ]
      }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: privateProjectPath,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    const trigger = screen.getByRole("combobox", { name: "Project" });
    expect(trigger).toHaveTextContent("Private Project");
    expect(trigger).not.toHaveTextContent(privateProjectPath);
    const triggerLabelFrame = trigger.querySelector<HTMLElement>(
      '[data-workspace-user-project-trigger-label="true"]'
    );
    expect(triggerLabelFrame).not.toBeNull();
    expect(getComputedStyle(triggerLabelFrame!).flexBasis).toBe("auto");
    const triggerLabel = trigger.querySelector<HTMLElement>(
      '[data-workspace-user-project-overflow-label="true"]'
    );
    expect(triggerLabel).not.toBeNull();
    expect(getComputedStyle(triggerLabel!).flexBasis).toBe("auto");
    expect(
      Array.from(document.querySelectorAll("style")).some((style) =>
        style.textContent?.includes("container-type: inline-size")
      )
    ).toBe(false);

    ensurePointerCaptureApi();
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    const privateProjectOption = await screen.findByRole("option", {
      name: "Private Project"
    });
    const windowsProjectOption = screen.getByRole("option", {
      name: "Windows Project"
    });
    expect(privateProjectOption).not.toHaveTextContent(privateProjectPath);
    expect(windowsProjectOption).not.toHaveTextContent(windowsProjectPath);
    expect(document.body).not.toHaveTextContent("/Users/local");
    expect(document.body).not.toHaveTextContent("C:\\Users");
  });

  it("creates a project directory from the add project dialog", async () => {
    const onProjectPathChange = vi.fn();
    mockAgentHostApi.userProjects = {
      create: vi.fn().mockResolvedValue({
        id: "dir-1",
        path: "/Users/local/Documents/tutti/Tutti Demo",
        label: "Tutti Demo"
      }),
      list: vi
        .fn()
        .mockResolvedValueOnce({ projects: [] })
        .mockResolvedValue({
          projects: [
            {
              id: "dir-1",
              path: "/Users/local/Documents/tutti/Tutti Demo",
              label: "Tutti Demo"
            }
          ]
        }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.click(await screen.findByRole("option", { name: "Add project" }));
    expect(await screen.findByRole("dialog")).toBeVisible();

    fireEvent.change(screen.getByPlaceholderText("Project name"), {
      target: { value: "Tutti Demo" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.create).toHaveBeenCalledWith({
        name: "Tutti Demo"
      })
    );
    expect(mockAgentHostApi.workspace.selectDirectory).not.toHaveBeenCalled();
    expect(onProjectPathChange).toHaveBeenCalledWith(
      "/Users/local/Documents/tutti/Tutti Demo",
      {
        action: "create_new",
        project: {
          id: "dir-1",
          path: "/Users/local/Documents/tutti/Tutti Demo",
          label: "Tutti Demo"
        }
      }
    );

    expect(mockAgentHostApi.userProjects?.use).not.toHaveBeenCalled();
  });

  it("shows a project name conflict when the created directory already exists", async () => {
    const onProjectPathChange = vi.fn();
    const conflictError = Object.assign(new Error("already exists"), {
      code: "project_directory_already_exists"
    });
    mockAgentHostApi.userProjects = {
      create: vi.fn().mockRejectedValue(conflictError),
      list: vi.fn().mockResolvedValue({ projects: [] }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.click(await screen.findByRole("option", { name: "Add project" }));
    fireEvent.change(await screen.findByPlaceholderText("Project name"), {
      target: { value: "Tutti Demo" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(
        "A project with this name already exists. Use another name."
      )
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(onProjectPathChange).not.toHaveBeenCalled();
  });

  it("shows project creation errors by nested error code", async () => {
    const onProjectPathChange = vi.fn();
    const permissionError = new Error("wrapped", {
      cause: Object.assign(new Error("permission denied"), {
        code: "project_directory_permission_denied"
      })
    });
    mockAgentHostApi.userProjects = {
      create: vi.fn().mockRejectedValue(permissionError),
      list: vi.fn().mockResolvedValue({ projects: [] }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.click(await screen.findByRole("option", { name: "Add project" }));
    fireEvent.change(await screen.findByPlaceholderText("Project name"), {
      target: { value: "Tutti Demo" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(
        "Tutti does not have permission to create folders in Documents."
      )
    ).toBeVisible();
    expect(onProjectPathChange).not.toHaveBeenCalled();
  });

  it("closes the add project dialog from cancel", async () => {
    mockAgentHostApi.userProjects = {
      create: vi.fn(),
      list: vi.fn().mockResolvedValue({ projects: [] }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    await openAddProjectDialog();

    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButtons[cancelButtons.length - 1] as HTMLElement);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(mockAgentHostApi.userProjects.create).not.toHaveBeenCalled();
  });

  it("hides the add project dialog close button and keeps cancel dismissal", async () => {
    mockAgentHostApi.userProjects = {
      create: vi.fn(),
      list: vi.fn().mockResolvedValue({ projects: [] }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    await openAddProjectDialog();

    const closeButton = document.querySelector<HTMLElement>(
      '[data-agent-project-dialog-close="true"]'
    );
    expect(closeButton).toBeNull();

    const cancelButtons = screen.getAllByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButtons[cancelButtons.length - 1] as HTMLElement);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(mockAgentHostApi.userProjects.create).not.toHaveBeenCalled();
  });

  it("links an existing project directory through the dropdown choices", async () => {
    const onProjectPathChange = vi.fn();
    const selectProjectDirectory = vi.fn().mockResolvedValue({
      path: "/workspace/existing"
    });
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({ projects: [] }),
      use: vi.fn().mockResolvedValue({
        id: "dir-2",
        path: "/workspace/existing",
        label: "existing"
      })
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        selectProjectDirectory={selectProjectDirectory}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "Use existing project" })
    );

    expect(selectProjectDirectory).toHaveBeenCalledTimes(1);
    expect(mockAgentHostApi.workspace.selectDirectory).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.use).toHaveBeenCalledWith({
        path: "/workspace/existing"
      })
    );
    expect(onProjectPathChange).toHaveBeenCalledWith("/workspace/existing", {
      action: "select_existing",
      project: {
        id: "dir-2",
        path: "/workspace/existing",
        label: "existing"
      }
    });
  });

  it("prefers the injected project directory picker over the service picker", async () => {
    const onProjectPathChange = vi.fn();
    const selectProjectDirectory = vi.fn().mockResolvedValue({
      path: "/workspace/injected"
    });
    const serviceSelectDirectory = vi.fn().mockResolvedValue({
      path: "/Users/vector/Documents/tutti/service"
    });
    const store = proxy({
      error: null,
      initialized: true,
      isLoading: false,
      projects: [],
      revision: 1
    }) as unknown as WorkspaceUserProjectService["store"];
    const service: WorkspaceUserProjectService = {
      store,
      async prepareSelection() {
        return {
          isSelectedPathMissing: false,
          projects: [],
          selection: { kind: "none" }
        };
      },
      async refresh() {},
      selectDirectory: serviceSelectDirectory
    };
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({ projects: [] }),
      service,
      use: vi.fn().mockResolvedValue({
        id: "dir-injected",
        path: "/workspace/injected",
        label: "injected"
      })
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        selectProjectDirectory={selectProjectDirectory}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Project" })).toBeVisible()
    );

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.click(
      await screen.findByRole("option", { name: "Use existing project" })
    );

    expect(selectProjectDirectory).toHaveBeenCalledTimes(1);
    expect(serviceSelectDirectory).not.toHaveBeenCalled();
    expect(mockAgentHostApi.workspace.selectDirectory).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.use).toHaveBeenCalledWith({
        path: "/workspace/injected"
      })
    );
    expect(onProjectPathChange).toHaveBeenCalledWith("/workspace/injected", {
      action: "select_existing",
      project: {
        id: "dir-injected",
        path: "/workspace/injected",
        label: "injected"
      }
    });
  });

  it("selects a known project without re-registering it", async () => {
    const onProjectPathChange = vi.fn();
    const rememberDefaultSelection = vi.fn();
    const useProject = vi.fn();
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "home",
            path: "/Users/ccr",
            label: "ccr"
          }
        ]
      }),
      rememberDefaultSelection,
      use: useProject
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.click(await screen.findByRole("option", { name: "ccr" }));

    expect(useProject).not.toHaveBeenCalled();
    expect(rememberDefaultSelection).toHaveBeenCalledWith({
      path: "/Users/ccr"
    });
    expect(onProjectPathChange).toHaveBeenCalledWith("/Users/ccr", {
      action: "select_existing"
    });
  });

  it("defaults to no project on first load", async () => {
    const onProjectPathChange = vi.fn();
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/tutti",
            label: "tutti"
          }
        ]
      }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
    );
    expect(onProjectPathChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent(
      "No project"
    );
  });

  it("keeps a remembered No project default", async () => {
    const onProjectPathChange = vi.fn();
    mockAgentHostApi.userProjects = {
      getDefaultSelection: vi.fn().mockResolvedValue({ path: null }),
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/tutti",
            label: "tutti"
          }
        ]
      }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() =>
      expect(
        mockAgentHostApi.userProjects?.getDefaultSelection
      ).toHaveBeenCalled()
    );
    expect(onProjectPathChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent(
      "No project"
    );
  });

  it("reacts to Valtio service project updates", async () => {
    const store = proxy({
      error: null,
      initialized: true,
      isLoading: false,
      projects: [
        {
          id: "dir-old",
          path: "/workspace/old",
          label: "Old"
        }
      ],
      revision: 1
    }) as WorkspaceUserProjectService["store"];
    const service: WorkspaceUserProjectService = {
      store,
      async prepareSelection() {
        return {
          isSelectedPathMissing: false,
          projects: [...store.projects],
          selection: { kind: "none" }
        };
      },
      async refresh() {}
    };
    const listProjects = vi.fn(async () => ({
      projects: [
        {
          id: "dir-api",
          path: "/workspace/api",
          label: "Api"
        }
      ]
    }));
    mockAgentHostApi.userProjects = {
      list: listProjects,
      service,
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: "/workspace/old",
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Project" })
      ).toHaveTextContent("Old")
    );
    expect(listProjects).not.toHaveBeenCalled();

    act(() => {
      store.projects = [
        ...store.projects,
        {
          id: "dir-new",
          path: "/workspace/new",
          label: "New"
        }
      ];
      store.revision += 1;
    });

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    expect(await screen.findByRole("option", { name: "New" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Api" })).toBeNull();
  });

  it("clears an unlocked selected project when it disappears from recents", async () => {
    const onProjectPathChange = vi.fn();
    const rememberDefaultSelection = vi.fn();
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: []
      }),
      rememberDefaultSelection,
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: "/workspace/deleted",
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() => expect(onProjectPathChange).toHaveBeenCalledWith(null));
    expect(rememberDefaultSelection).toHaveBeenCalledWith({ path: null });
    expect(mockAgentHostApi.userProjects.use).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Project" })
      ).toHaveTextContent("No project")
    );
  });

  it("shows a missing working directory notice for locked stale projects", async () => {
    const onProjectMissingChange = vi.fn();
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/active",
            label: "active"
          }
        ]
      }),
      checkPath: vi.fn().mockResolvedValue({
        exists: false,
        isDirectory: false,
        path: "/workspace/deleted"
      }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: "/workspace/deleted",
          projectLocked: true
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectMissingChange={onProjectMissingChange}
        onProjectPathChange={vi.fn()}
      />
    );

    expect(
      await screen.findByText("Current working directory missing")
    ).toBeVisible();
    await waitFor(() =>
      expect(onProjectMissingChange).toHaveBeenCalledWith(true)
    );
    expect(mockAgentHostApi.userProjects.use).not.toHaveBeenCalled();
  });

  it("does not mark locked projects missing just because they are absent from recents", async () => {
    const onProjectMissingChange = vi.fn();
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/active",
            label: "active"
          }
        ]
      }),
      checkPath: vi.fn().mockResolvedValue({
        exists: true,
        isDirectory: true,
        path: "/workspace/from-launch"
      }),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: "/workspace/from-launch",
          projectLocked: true
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectMissingChange={onProjectMissingChange}
        onProjectPathChange={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.checkPath).toHaveBeenCalledWith({
        path: "/workspace/from-launch"
      })
    );
    await waitFor(() =>
      expect(onProjectMissingChange).toHaveBeenLastCalledWith(false)
    );
    expect(
      screen.getByRole("combobox", { name: "Project locked" })
    ).toHaveTextContent("from-launch");
    expect(screen.queryByText("Current working directory missing")).toBeNull();
  });

  it("shows locked no-project paths as No project", async () => {
    const noProjectPath =
      "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444";
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: []
      }),
      checkPath: vi.fn().mockResolvedValue({
        exists: true,
        isDirectory: true,
        path: noProjectPath
      }),
      isNoProjectPath: vi.fn(({ path }) => path === noProjectPath),
      use: vi.fn()
    };

    render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: noProjectPath,
          projectLocked: true
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={vi.fn()}
      />
    );

    const userProjects = mockAgentHostApi.userProjects!;
    await waitFor(() =>
      expect(userProjects.isNoProjectPath).toHaveBeenCalledWith({
        path: noProjectPath
      })
    );
    expect(
      screen.getByRole("combobox", { name: "Project locked" })
    ).toHaveTextContent("No project");
    expect(userProjects.checkPath).not.toHaveBeenCalled();
  });

  it("keeps No project as a session choice without updating recent projects", async () => {
    const onProjectPathChange = vi.fn();
    const listProjects = vi.fn().mockResolvedValue({
      projects: [
        {
          id: "dir-1",
          path: "/workspace/tutti",
          label: "tutti"
        }
      ]
    });
    const useProject = vi.fn();
    const rememberDefaultSelection = vi.fn();
    mockAgentHostApi.userProjects = {
      list: listProjects,
      rememberDefaultSelection,
      use: useProject
    };

    const { rerender } = render(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: "/workspace/tutti",
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));

    ensurePointerCaptureApi();
    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.click(await screen.findByRole("option", { name: "No project" }));

    expect(onProjectPathChange).toHaveBeenCalledWith(null, {
      action: "clear"
    });
    expect(rememberDefaultSelection).toHaveBeenCalledWith({ path: null });
    expect(useProject).not.toHaveBeenCalled();
    onProjectPathChange.mockClear();

    rerender(
      <AgentProjectDropdown
        composerSettings={{
          selectedProjectPath: null,
          projectLocked: false
        }}
        labels={projectLabels}
        i18n={workspaceUserProjectI18n}
        onProjectPathChange={onProjectPathChange}
      />
    );

    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(onProjectPathChange).not.toHaveBeenCalled();
  });
});

function ensurePointerCaptureApi(): void {
  if (!("hasPointerCapture" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      value: () => false,
      configurable: true
    });
  }
  if (!("setPointerCapture" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      value: () => undefined,
      configurable: true
    });
  }
  if (!("releasePointerCapture" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      value: () => undefined,
      configurable: true
    });
  }
}

async function openAddProjectDialog(): Promise<void> {
  await waitFor(() =>
    expect(mockAgentHostApi.userProjects?.list).toHaveBeenCalled()
  );

  ensurePointerCaptureApi();
  fireEvent.pointerDown(screen.getByRole("combobox", { name: "Project" }), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
    pointerType: "mouse"
  });
  fireEvent.click(await screen.findByRole("option", { name: "Add project" }));
  expect(await screen.findByRole("dialog")).toBeVisible();
}

function modelReasoningTrigger(): HTMLElement {
  return screen.getByRole("button", { name: "Model / Reasoning" });
}

function openModelReasoningMenu(): void {
  fireEvent.pointerDown(modelReasoningTrigger(), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
    pointerType: "mouse"
  });
}

function openComposerSubmenu(trigger: HTMLElement): void {
  // Radix opens a submenu from its SubTrigger on click; the keyboard/hover
  // paths depend on roving-focus state that jsdom does not fully model.
  trigger.focus();
  fireEvent.click(trigger);
}

function renderPermissionModeDropdown(
  permissionMode: string,
  overrides: Partial<AgentGUIComposerSettingsVM> = {}
) {
  return render(
    <TooltipProvider>
      <AgentPermissionModeDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: null,
            reasoningEffort: null,
            speed: null,
            planMode: false,
            permissionModeId: permissionMode
          },
          supportsModel: false,
          supportsReasoningEffort: false,
          supportsSpeed: false,
          speedUnavailable: false,
          availableSpeeds: [],
          supportsPermissionMode: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          permissionModeUnavailable: false,
          availableModels: [],
          availableReasoningEfforts: [],
          availablePermissionModes: [
            {
              value: "read-only",
              label: "Ask for approval",
              description: "Needs approval before making changes."
            },
            { value: "auto", label: "Approve for me" },
            {
              value: "full-access",
              label: "Full access",
              description: "Can make changes and run commands directly."
            }
          ],
          ...overrides
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    </TooltipProvider>
  );
}

describe("AgentPermissionModeDropdown", () => {
  it("colors the ask for approval trigger with the success token", () => {
    renderPermissionModeDropdown("read-only");

    expect(
      screen.getByRole("combobox", { name: "Run permissions" })
    ).toHaveAttribute("data-permission-tone", "success");
  });

  it("wires a loading hint tooltip while composer options load", () => {
    renderPermissionModeDropdown("full-access", {
      isSettingsLoading: true,
      availablePermissionModes: []
    });
    const combobox = screen.getByRole("combobox", { name: "Run permissions" });
    const wrapper = combobox.closest("span[tabindex]");
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute("data-state");
    // The trigger must show the loading copy, never the raw permission-mode id.
    expect(combobox).toHaveTextContent("Loading…");
    expect(combobox).not.toHaveTextContent("full-access");
  });

  it("omits the loading hint once permission options are available", () => {
    renderPermissionModeDropdown("read-only");
    expect(
      screen
        .getByRole("combobox", { name: "Run permissions" })
        .closest("span[tabindex]")
    ).toBeNull();
  });

  it("colors the ask for approval trigger when the selected value is display text", () => {
    renderPermissionModeDropdown("Ask for approval");

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    expect(trigger).toHaveTextContent("Ask for approval");
    expect(trigger).toHaveAttribute("data-permission-tone", "success");
  });

  it("shows the current permission id when it is missing from provider options", async () => {
    renderPermissionModeDropdown("custom-safe");

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    expect(trigger).toHaveTextContent("custom-safe");

    ensurePointerCaptureApi();
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    expect(
      await screen.findByRole("option", { name: "custom-safe" })
    ).toHaveAttribute("aria-selected", "true");
  });

  it("colors the ask first trigger with the accent token", () => {
    renderPermissionModeDropdown("auto");

    expect(
      screen.getByRole("combobox", { name: "Run permissions" })
    ).toHaveAttribute("data-permission-tone", "accent");
  });

  it("colors the full access trigger with the warning token", () => {
    renderPermissionModeDropdown("full-access");

    expect(
      screen.getByRole("combobox", { name: "Run permissions" })
    ).toHaveAttribute("data-permission-tone", "warning");
  });

  it("colors the full access trigger when the selected value is display text", () => {
    renderPermissionModeDropdown("Full access");

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    expect(trigger).toHaveTextContent("Full access");
    expect(trigger).toHaveAttribute("data-permission-tone", "warning");
  });

  it("does not render a group title when permissions are the only menu group", async () => {
    renderPermissionModeDropdown("full-access");

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    ensurePointerCaptureApi();
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    expect(
      await screen.findByRole("option", { name: "Full access" })
    ).toBeVisible();
    expect(screen.queryByText("Run permissions")).toBeNull();
  });

  it("keeps the permission menu close to the trigger", async () => {
    renderPermissionModeDropdown("auto");

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    ensurePointerCaptureApi();
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    const menu = (
      await screen.findByRole("option", {
        name: "Approve for me"
      })
    ).closest('[data-slot="select-content"]');
    expect(menu).toHaveClass("data-[side=top]:!translate-y-0");
  });

  it("shows permission descriptions in an info tooltip", async () => {
    renderPermissionModeDropdown("full-access");

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    ensurePointerCaptureApi();
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    const option = await screen.findByRole("option", { name: "Full access" });
    const infoTrigger = option.querySelector(
      '[data-agent-composer-option-info-trigger="true"]'
    );
    if (!infoTrigger) {
      throw new Error("Expected permission option info trigger");
    }

    expect(infoTrigger.className).toContain("opacity-0");
    expect(infoTrigger.className).toContain(
      "group-hover/composer-option:opacity-100"
    );

    fireEvent.mouseEnter(option);
    fireEvent.pointerMove(infoTrigger, { pointerType: "mouse" });

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Can make changes and run commands directly."
    );
  });

  function renderPlanCapableDropdown(input: {
    planMode: boolean;
    planExclusiveWithPermissionMode?: boolean;
    onSettingsChange?: (patch: {
      permissionModeId?: string | null;
      planMode?: boolean;
    }) => void;
  }) {
    return render(
      <TooltipProvider>
        <AgentPermissionModeDropdown
          composerSettings={{
            sessionSettings: null,
            draftSettings: {
              model: null,
              reasoningEffort: null,
              speed: null,
              planMode: input.planMode,
              permissionModeId: "default"
            },
            supportsModel: false,
            supportsReasoningEffort: false,
            supportsSpeed: false,
            speedUnavailable: false,
            availableSpeeds: [],
            supportsPermissionMode: true,
            supportsPlanMode: true,
            planExclusiveWithPermissionMode:
              input.planExclusiveWithPermissionMode ?? false,
            isSettingsLoading: false,
            modelUnavailable: false,
            reasoningUnavailable: false,
            permissionModeUnavailable: false,
            availableModels: [],
            availableReasoningEfforts: [],
            availablePermissionModes: [
              { value: "default", label: "Ask for approval" },
              { value: "acceptEdits", label: "Accept edits" }
            ]
          }}
          labels={labels}
          onSettingsChange={input.onSettingsChange ?? vi.fn()}
        />
      </TooltipProvider>
    );
  }

  it("never surfaces plan mode as a dropdown option", async () => {
    renderPlanCapableDropdown({ planMode: false });

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    expect(trigger).toHaveTextContent("Ask for approval");

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });

    await screen.findByRole("option", { name: "Ask for approval" });
    expect(screen.queryByRole("option", { name: "Plan Mode" })).toBeNull();
  });

  it("clears plan mode on permission pick for mutually-exclusive providers (claude-code)", async () => {
    const onSettingsChange = vi.fn();
    renderPlanCapableDropdown({
      planMode: true,
      planExclusiveWithPermissionMode: true,
      onSettingsChange
    });

    const trigger = screen.getByRole("combobox", { name: "Run permissions" });
    // Plan rides as a separate badge now; the trigger shows the permission mode.
    expect(trigger).toHaveTextContent("Ask for approval");

    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    });
    fireEvent.pointerDown(
      await screen.findByRole("option", { name: "Accept edits" }),
      { button: 0, ctrlKey: false, pointerId: 2, pointerType: "mouse" }
    );

    expect(onSettingsChange).toHaveBeenCalledWith({
      permissionModeId: "acceptEdits",
      planMode: false
    });
  });

  it("leaves plan mode intact on permission pick for independent providers (codex)", async () => {
    const onSettingsChange = vi.fn();
    renderPlanCapableDropdown({
      planMode: true,
      planExclusiveWithPermissionMode: false,
      onSettingsChange
    });

    fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Run permissions" }),
      { button: 0, ctrlKey: false, pointerId: 1, pointerType: "mouse" }
    );
    fireEvent.pointerDown(
      await screen.findByRole("option", { name: "Accept edits" }),
      { button: 0, ctrlKey: false, pointerId: 2, pointerType: "mouse" }
    );

    expect(onSettingsChange).toHaveBeenCalledWith({
      permissionModeId: "acceptEdits"
    });
  });
});

describe("AgentModelReasoningDropdown", () => {
  function renderModelReasoning(
    overrides: Partial<AgentGUIComposerSettingsVM> = {},
    onSettingsChange: (patch: {
      model?: string;
      reasoningEffort?: string;
      speed?: string;
    }) => void = vi.fn()
  ) {
    const composerSettings: AgentGUIComposerSettingsVM = {
      sessionSettings: null,
      draftSettings: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        speed: "standard",
        planMode: false,
        permissionModeId: "preset"
      },
      supportsModel: true,
      supportsReasoningEffort: true,
      supportsSpeed: true,
      speedUnavailable: false,
      availableSpeeds: [
        { value: "standard", label: "standard", description: "Standard speed" },
        { value: "fast", label: "fast", description: "1.5x speed" }
      ],
      supportsPlanMode: false,
      isSettingsLoading: false,
      modelUnavailable: false,
      reasoningUnavailable: false,
      availableModels: [
        { value: "gpt-5.5", label: "gpt-5.5" },
        { value: "gpt-5.4", label: "gpt-5.4" }
      ],
      availableReasoningEfforts: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" }
      ],
      ...overrides
    };
    return {
      onSettingsChange,
      ...render(
        <TooltipProvider>
          <AgentModelReasoningDropdown
            composerSettings={composerSettings}
            labels={labels}
            onSettingsChange={onSettingsChange}
          />
        </TooltipProvider>
      )
    };
  }

  it("keeps model options vertically centered when they have no description", async () => {
    renderModelReasoning();

    openModelReasoningMenu();

    await screen.findByRole("menu");
    const menu = document.querySelector(
      '[data-agent-composer-settings-layout="model-primary"]'
    );
    const modelOption =
      Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? []).find(
        (item) => item.textContent?.includes("GPT-5.5")
      ) ?? null;
    expect(modelOption).not.toBeNull();
    expect(modelOption).not.toHaveClass("items-start");
  });

  it("shows model and reasoning together in the trigger", () => {
    renderModelReasoning();
    const trigger = modelReasoningTrigger();
    expect(trigger).toHaveTextContent(/GPT-5\.5\s*High/);

    const chevron = trigger.querySelector(".lucide-chevron-down");
    expect(chevron).not.toBeNull();
    expect(chevron).toHaveAttribute("width", "16");
    expect(chevron).toHaveAttribute("height", "16");
    expect(chevron).not.toHaveClass("size-3");
  });

  it("shows the fast lightning indicator only when speed is fast", () => {
    const { unmount } = renderModelReasoning();
    expect(
      document.querySelector('[data-agent-speed-indicator="fast"]')
    ).toBeNull();
    unmount();
    renderModelReasoning({
      draftSettings: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        speed: "fast",
        planMode: false,
        permissionModeId: "preset"
      },
      selectedSpeedValue: "fast"
    });
    expect(
      document.querySelector('[data-agent-speed-indicator="fast"]')
    ).not.toBeNull();
  });

  it("lists models as the primary menu and selects one", async () => {
    const onSettingsChange = vi.fn();
    renderModelReasoning({}, onSettingsChange);
    openModelReasoningMenu();
    const current = await screen.findByRole("menuitem", {
      name: /GPT-5\.5/
    });
    expect(current).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /GPT-5\.4/ }));
    expect(onSettingsChange).toHaveBeenCalledWith({ model: "gpt-5.4" });
  });

  it("capitalizes model labels without changing the model value", async () => {
    const onSettingsChange = vi.fn();
    renderModelReasoning(
      {
        draftSettings: {
          model: "sonnet[1m]",
          reasoningEffort: "high",
          speed: "standard",
          planMode: false,
          permissionModeId: "preset"
        },
        availableModels: [
          { value: "default", label: "default" },
          { value: "sonnet[1m]", label: "sonnet[1m]" }
        ]
      },
      onSettingsChange
    );
    openModelReasoningMenu();
    expect(
      await screen.findByRole("menuitem", { name: /Sonnet\[1m\]/ })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Default/ }));
    expect(onSettingsChange).toHaveBeenCalledWith({ model: "default" });
  });

  it("exposes reasoning as a submenu reflecting the current value", async () => {
    const onSettingsChange = vi.fn();
    renderModelReasoning({}, onSettingsChange);
    openModelReasoningMenu();
    const reasoningTrigger = await screen.findByRole("menuitem", {
      name: /Reasoning/
    });
    expect(reasoningTrigger).toHaveTextContent("High");
    expect(reasoningTrigger).toHaveClass("[&>svg]:!ml-0.5");
    openComposerSubmenu(reasoningTrigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Low" }));
    expect(onSettingsChange).toHaveBeenCalledWith({ reasoningEffort: "low" });
  });

  it("exposes speed as a submenu and switches to fast", async () => {
    const onSettingsChange = vi.fn();
    renderModelReasoning({}, onSettingsChange);
    openModelReasoningMenu();
    const speedTrigger = await screen.findByRole("menuitem", { name: /Speed/ });
    expect(speedTrigger).toHaveTextContent("Standard");
    expect(speedTrigger).toHaveClass("[&>svg]:!ml-0.5");
    openComposerSubmenu(speedTrigger);
    const standardSpeedDescription = await screen.findByText("Standard speed");
    expect(standardSpeedDescription.parentElement).toHaveClass("gap-0.5");
    fireEvent.click(await screen.findByRole("menuitem", { name: /Fast/ }));
    expect(onSettingsChange).toHaveBeenCalledWith({ speed: "fast" });
  });

  it("disables the trigger when nothing is configurable", () => {
    renderModelReasoning({
      supportsModel: false,
      supportsReasoningEffort: false,
      supportsSpeed: false,
      availableModels: [],
      availableReasoningEfforts: [],
      availableSpeeds: []
    });
    expect(modelReasoningTrigger()).toBeDisabled();
  });

  it("marks the trigger as loading while ACP config options load", () => {
    renderModelReasoning({ isSettingsLoading: true });
    expect(modelReasoningTrigger()).toHaveClass("animate-pulse");
  });

  it("wires a loading hint tooltip while the model list loads", () => {
    renderModelReasoning({ isModelOptionsLoading: true });
    // The trigger is wrapped in a focusable span so the loading tooltip can
    // surface even when the (disabled) trigger swallows pointer events.
    const wrapper = modelReasoningTrigger().closest("span[tabindex]");
    expect(wrapper).not.toBeNull();
    // Radix marks its tooltip trigger with data-state, confirming the span is
    // the loading-hint tooltip's trigger rather than a bare wrapper.
    expect(wrapper).toHaveAttribute("data-state");
  });

  it("omits the loading hint once models are available", () => {
    renderModelReasoning({ isModelOptionsLoading: false });
    expect(modelReasoningTrigger().closest("span[tabindex]")).toBeNull();
  });

  it("shows model details in right-side row tooltips", async () => {
    render(
      <TooltipProvider>
        <AgentModelReasoningDropdown
          composerSettings={{
            sessionSettings: null,
            draftSettings: {
              model: "gpt-5.5",
              reasoningEffort: "high",
              speed: "standard",
              planMode: false,
              permissionModeId: "preset"
            },
            supportsModel: true,
            supportsReasoningEffort: true,
            supportsSpeed: false,
            speedUnavailable: false,
            availableSpeeds: [],
            supportsPlanMode: false,
            isSettingsLoading: false,
            modelUnavailable: false,
            reasoningUnavailable: false,
            selectedModelValue: "gpt-5.5",
            selectedReasoningEffortValue: "high",
            availableModels: [
              {
                value: "gpt-5.5",
                label: "GPT-5.5",
                description:
                  "Frontier model for complex coding, research, and real-world work."
              },
              {
                value: "custom",
                label: "Custom",
                description:
                  "Custom 1.0 with 1M context · Custom model description · high effort"
              }
            ],
            availableReasoningEfforts: [{ value: "high", label: "High" }]
          }}
          labels={{
            ...labels,
            modelDescriptions: {
              ...labels.modelDescriptions,
              frontierComplexCoding: "复杂编码模型说明"
            }
          }}
          onSettingsChange={vi.fn()}
        />
      </TooltipProvider>
    );

    openModelReasoningMenu();

    expect(screen.queryByText("复杂编码模型说明")).toBeNull();
    expect(
      screen.queryByText(
        "Frontier model for complex coding, research, and real-world work."
      )
    ).toBeNull();

    const localizedOption = await screen.findByRole("menuitem", {
      name: /GPT-5\.5/
    });
    expect(localizedOption).toHaveAttribute(
      "data-agent-model-option-tooltip-trigger",
      "true"
    );
    fireEvent.mouseEnter(localizedOption);
    fireEvent.pointerMove(localizedOption, { pointerType: "mouse" });
    const localizedTooltip = await screen.findByRole("tooltip");
    expect(localizedTooltip).toHaveTextContent("复杂编码模型说明");
    const localizedTooltipDescription = Array.from(
      localizedTooltip.querySelectorAll("span")
    ).find((element) => element.textContent === "复杂编码模型说明");
    expect(localizedTooltipDescription).toHaveClass(
      "text-[var(--text-tertiary)]"
    );
    const localizedTooltipSurface = document.querySelector(
      '[data-agent-model-option-tooltip="true"]'
    );
    if (!localizedTooltipSurface) {
      throw new Error("Expected localized model tooltip surface");
    }
    expect(localizedTooltipSurface).toHaveClass(
      "flex",
      "flex-col",
      "items-start",
      "gap-0"
    );

    const customOption = await screen.findByRole("menuitem", {
      name: /Custom/
    });
    expect(customOption).toHaveTextContent("1M");
    expect(customOption).toHaveTextContent("High");
    expect(customOption).toHaveAttribute(
      "data-agent-model-option-tooltip-trigger",
      "true"
    );
    fireEvent.mouseEnter(customOption);
    fireEvent.pointerMove(customOption, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Custom model description");
    expect(tooltip).toHaveTextContent("1M context window");
    expect(tooltip).toHaveTextContent("Version: high effort");
  });
});

const labels = {
  modelLabel: "Model",
  modelSelectionLabel: "Model selection",
  modelContextWindowSuffix: "context window",
  modelTooltipVersionLabel: "Version",
  defaultModel: "Default model",
  loadingOptions: "Loading…",
  inheritedUnavailable: "Unavailable",
  reasoningLabel: "Reasoning",
  reasoningDegreeLabel: "Reasoning degree",
  reasoningOptionDefault: "Default",
  reasoningOptionMinimal: "Minimal",
  reasoningOptionLow: "Low",
  reasoningOptionMedium: "Medium",
  reasoningOptionHigh: "High",
  reasoningOptionXHigh: "X High",
  reasoningOptionMax: "Max",
  speedLabel: "Speed",
  speedSelectionLabel: "Speed",
  speedOptionStandard: "Standard",
  speedOptionStandardDescription: "Standard speed",
  speedOptionFast: "Fast",
  speedOptionFastDescription: "1.5x speed",
  permissionLabel: "Run permissions",
  planModeLabel: "Plan Mode",
  permissionModeReadOnly: "Ask for approval",
  permissionModeAuto: "Approve for me",
  permissionModeFullAccess: "Full access",
  modelDescriptions: {
    frontierComplexCoding:
      "Frontier model for complex coding, research, and real-world work.",
    everydayCoding: "Strong model for everyday coding.",
    smallFastCostEfficient:
      "Small, fast, and cost-efficient model for simpler coding tasks.",
    codingOptimized: "Coding-optimized model.",
    ultraFastCoding: "Ultra-fast coding model.",
    professionalLongRunning:
      "Optimized for professional work and long-running agents."
  }
} satisfies Parameters<typeof AgentModelReasoningDropdown>[0]["labels"];

const projectLabels = {
  projectLocked: "Project locked",
  projectMissingDescription:
    "This conversation's working directory no longer exists"
} satisfies Parameters<typeof AgentProjectDropdown>[0]["labels"];
