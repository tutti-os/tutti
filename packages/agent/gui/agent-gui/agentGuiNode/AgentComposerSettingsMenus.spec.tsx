import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("opens the project folder menu through ui-system Select layering", async () => {
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/nextop",
            label: "nextop"
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
      name: /nextop/
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
    expect(projectOption).toHaveTextContent("nextop");
    expect(projectOption).not.toHaveTextContent("/workspace/nextop");
    expect(
      document.querySelector('[data-slot="select-separator"]')
    ).not.toBeNull();
    const noProjectOption = screen.getByRole("option", {
      name: "No project"
    });
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "nextop",
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
        path: "/Users/local/Documents/nextop/Nextop Demo",
        label: "Nextop Demo"
      }),
      list: vi
        .fn()
        .mockResolvedValueOnce({ projects: [] })
        .mockResolvedValue({
          projects: [
            {
              id: "dir-1",
              path: "/Users/local/Documents/nextop/Nextop Demo",
              label: "Nextop Demo"
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
      target: { value: "Nextop Demo" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.create).toHaveBeenCalledWith({
        name: "Nextop Demo"
      })
    );
    expect(mockAgentHostApi.workspace.selectDirectory).not.toHaveBeenCalled();
    expect(onProjectPathChange).toHaveBeenCalledWith(
      "/Users/local/Documents/nextop/Nextop Demo",
      { action: "create_new" }
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
      target: { value: "Nextop Demo" }
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
      target: { value: "Nextop Demo" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(
        "Nextop does not have permission to create folders in Documents."
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
    mockAgentHostApi.workspace.selectDirectory.mockResolvedValue({
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

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.use).toHaveBeenCalledWith({
        path: "/workspace/existing"
      })
    );
    expect(onProjectPathChange).toHaveBeenCalledWith("/workspace/existing", {
      action: "select_existing"
    });
  });

  it("defaults to the most recent project on first load", async () => {
    const onProjectPathChange = vi.fn();
    mockAgentHostApi.userProjects = {
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/nextop",
            label: "nextop"
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
      expect(onProjectPathChange).toHaveBeenCalledWith("/workspace/nextop")
    );
  });

  it("keeps a remembered No project default instead of using the most recent project", async () => {
    const onProjectPathChange = vi.fn();
    mockAgentHostApi.userProjects = {
      getDefaultSelection: vi.fn().mockResolvedValue({ path: null }),
      list: vi.fn().mockResolvedValue({
        projects: [
          {
            id: "dir-1",
            path: "/workspace/nextop",
            label: "nextop"
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
      "/Users/local/Documents/nextop/session-44444444-4444-4444-8444-444444444444";
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

    await waitFor(() =>
      expect(mockAgentHostApi.userProjects?.checkPath).toHaveBeenCalledWith({
        path: noProjectPath
      })
    );
    expect(
      screen.getByRole("combobox", { name: "Project locked" })
    ).toHaveTextContent("No project");
    expect(mockAgentHostApi.userProjects.isNoProjectPath).toHaveBeenCalledWith({
      path: noProjectPath
    });
  });

  it("keeps No project as a session choice without updating recent projects", async () => {
    const onProjectPathChange = vi.fn();
    const listProjects = vi.fn().mockResolvedValue({
      projects: [
        {
          id: "dir-1",
          path: "/workspace/nextop",
          label: "nextop"
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
          selectedProjectPath: "/workspace/nextop",
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

function openModelReasoningMenu(): void {
  fireEvent.pointerDown(
    screen.getByRole("combobox", { name: "Model / Reasoning" }),
    {
      button: 0,
      ctrlKey: false,
      pointerId: 1,
      pointerType: "mouse"
    }
  );
}

function renderPermissionModeDropdown(permissionMode: string) {
  return render(
    <TooltipProvider>
      <AgentPermissionModeDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: null,
            reasoningEffort: null,
            planMode: false,
            permissionModeId: permissionMode
          },
          supportsModel: false,
          supportsReasoningEffort: false,
          supportsPermissionMode: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          permissionModeUnavailable: false,
          planUnavailable: false,
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
          ]
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
      '[data-agent-permission-info-trigger="true"]'
    );
    if (!infoTrigger) {
      throw new Error("Expected permission option info trigger");
    }

    expect(infoTrigger.className).toContain("opacity-0");
    expect(infoTrigger.className).toContain(
      "group-hover/permission-option:opacity-100"
    );

    fireEvent.mouseEnter(option);
    fireEvent.pointerMove(infoTrigger, { pointerType: "mouse" });

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Can make changes and run commands directly."
    );
  });
});

describe("AgentModelReasoningDropdown", () => {
  it("keeps menu option vertical padding at 4px", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer-menu-item\s*{[^}]*padding-block:\s*4px[^}]*padding-inline:\s*10px\s+28px/s
    );
  });

  it("places model selection on the left and reasoning on the right", () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: "sonnet",
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          availableModels: [
            { value: "default", label: "default" },
            { value: "sonnet", label: "sonnet" }
          ],
          availableReasoningEfforts: [
            { value: "low", label: "Low" },
            { value: "high", label: "High" }
          ]
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    openModelReasoningMenu();

    const layout = document.querySelector(
      '[data-agent-composer-settings-layout="split"]'
    );
    if (!layout) {
      throw new Error("Expected split model/reasoning menu layout");
    }
    expect(layout.closest('[data-slot="select-content"]')).toHaveClass(
      "data-[side=top]:!translate-y-0"
    );

    const [leftColumn, , rightColumn] = Array.from(layout.children);
    if (!leftColumn || !rightColumn) {
      throw new Error("Expected model and reasoning columns");
    }

    expect(leftColumn.firstElementChild).toHaveTextContent("Model selection");
    expect(leftColumn).toHaveTextContent("Default");
    expect(leftColumn).toHaveTextContent("Sonnet");
    expect(leftColumn).not.toHaveTextContent("High");
    expect(rightColumn.firstElementChild).toHaveTextContent("Reasoning degree");
    expect(rightColumn).toHaveTextContent("Low");
    expect(rightColumn).toHaveTextContent("High");
    expect(rightColumn).not.toHaveTextContent("Sonnet");
    const selectedReasoningOption = screen.getByRole("option", {
      name: "High"
    });
    expect(
      selectedReasoningOption.querySelector(
        '[data-slot="select-item-forced-indicator"]'
      )
    ).not.toBeNull();
  });

  it("capitalizes model option labels without changing model values", async () => {
    const onSettingsChange = vi.fn();
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: "sonnet[1m]",
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          availableModels: [
            { value: "default", label: "default" },
            { value: "sonnet[1m]", label: "sonnet[1m]" }
          ],
          availableReasoningEfforts: [{ value: "high", label: "High" }]
        }}
        labels={labels}
        onSettingsChange={onSettingsChange}
      />
    );

    const trigger = screen.getByRole("combobox", {
      name: "Model / Reasoning"
    });
    expect(trigger).toHaveTextContent(/Sonnet\[1m\]\s*High/);

    openModelReasoningMenu();
    const sonnetOption = await screen.findByRole("option", {
      name: "Sonnet[1m]"
    });
    expect(sonnetOption).toHaveAttribute("aria-selected", "true");

    fireEvent.click(await screen.findByRole("option", { name: "Default" }));

    expect(onSettingsChange).toHaveBeenCalledWith({ model: "default" });
  });

  it("truncates long model names while keeping reasoning visible", () => {
    const longModelLabel =
      "Super Ultra Extended GPT Model Name For Long Context Coding";
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: "super-ultra-extended-gpt-model-name",
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          availableModels: [
            {
              value: "super-ultra-extended-gpt-model-name",
              label: longModelLabel
            }
          ],
          availableReasoningEfforts: [{ value: "high", label: "High" }]
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("combobox", { name: "Model / Reasoning" })
    ).toHaveAttribute("data-agent-model-reasoning-trigger", "true");
    expect(
      screen.getByRole("combobox", { name: "Model / Reasoning" })
        .firstElementChild
    ).toHaveClass("overflow-hidden");
    expect(screen.getByText(longModelLabel)).toHaveClass("truncate");
    expect(screen.getByText("High")).toHaveClass("shrink-0");
  });

  it("renders unavailable model and reasoning controls as visibly disabled", () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: null,
            reasoningEffort: null,
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: true,
          reasoningUnavailable: true,
          planUnavailable: false,
          availableModels: [],
          availableReasoningEfforts: []
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("combobox", {
      name: "Model / Reasoning"
    });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveClass("agent-gui-node__composer-menu-trigger");
    expect(trigger).toHaveClass("cursor-not-allowed");
    expect(trigger).toHaveClass("opacity-60");
    expect(trigger).toHaveClass("text-[var(--agent-gui-text-tertiary)]");
  });

  it("omits the reasoning label when no reasoning options are available", () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: {
            model: "haiku",
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "auto"
          },
          draftSettings: {
            model: "haiku",
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          availableModels: [{ value: "haiku", label: "Haiku" }],
          availableReasoningEfforts: []
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("combobox", {
      name: "Model / Reasoning"
    });
    expect(trigger).toHaveTextContent("Haiku");
    expect(trigger).not.toHaveTextContent("Reasoning");
  });

  it("shows a loading trigger while ACP config options are loading", () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: null,
            reasoningEffort: null,
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: true,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          availableModels: [],
          availableReasoningEfforts: []
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("combobox", {
      name: "Model / Reasoning"
    });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("Loading conversation");
    expect(trigger).toHaveClass("animate-pulse");
  });

  it("marks the ACP current model as selected even when no draft model is set", async () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: null,
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          selectedModelValue: "default",
          selectedReasoningEffortValue: "high",
          availableModels: [
            { value: "default", label: "Default" },
            { value: "opus", label: "Opus" }
          ],
          availableReasoningEfforts: [{ value: "high", label: "High" }]
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("combobox", {
      name: "Model / Reasoning"
    });
    expect(trigger).toHaveTextContent(/Default\s*High/);

    openModelReasoningMenu();
    const defaultOption = await screen.findByRole("option", {
      name: "Default"
    });
    expect(defaultOption).toHaveAttribute("aria-selected", "true");
  });

  it("keeps displaying current model and reasoning when they are missing from provider options", async () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: "custom-model",
            reasoningEffort: "experimental",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          selectedModelValue: "custom-model",
          selectedReasoningEffortValue: "experimental",
          availableModels: [
            { value: "default", label: "Default" },
            { value: "opus", label: "Opus" }
          ],
          availableReasoningEfforts: [{ value: "high", label: "High" }]
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    const trigger = screen.getByRole("combobox", {
      name: "Model / Reasoning"
    });
    expect(trigger).toHaveTextContent(/Custom-model\s*experimental/);
    expect(trigger).not.toHaveTextContent("Default");

    openModelReasoningMenu();
    const selectedModelOption = await screen.findByRole("option", {
      name: "Custom-model"
    });
    expect(selectedModelOption).toHaveAttribute("aria-selected", "true");
    const selectedReasoningOption = await screen.findByRole("option", {
      name: "experimental"
    });
    expect(selectedReasoningOption).toBeVisible();
  });

  it("uses ui-system dropdown layering for the wider asymmetric split menu", async () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: null,
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
          selectedModelValue: "minimax-haiku",
          selectedReasoningEffortValue: "high",
          availableModels: [
            {
              value: "default",
              label: "Default",
              description:
                "Use the default model (currently MiniMax-M2.7[1m]) · $5/$25 per Mtok"
            },
            {
              value: "minimax-haiku",
              label: "MiniMax-M2.7",
              description: "Custom Haiku model"
            }
          ],
          availableReasoningEfforts: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "X High" }
          ]
        }}
        labels={labels}
        onSettingsChange={vi.fn()}
      />
    );

    openModelReasoningMenu();

    const menu = await screen.findByRole("listbox");
    expect(menu).toHaveClass("w-[430px]");
    expect(menu).toHaveStyle({ zIndex: "var(--z-popover)" });
    expect(
      menu.querySelector('[data-agent-composer-settings-layout="split"]')
    ).toHaveClass("grid-cols-[minmax(0,1fr)_1px_minmax(104px,132px)]");
  });

  it("localizes known model descriptions while preserving custom descriptions", async () => {
    render(
      <AgentModelReasoningDropdown
        composerSettings={{
          sessionSettings: null,
          draftSettings: {
            model: "gpt-5.5",
            reasoningEffort: "high",
            planMode: false,
            permissionModeId: "preset"
          },
          supportsModel: true,
          supportsReasoningEffort: true,
          supportsPlanMode: false,
          isSettingsLoading: false,
          modelUnavailable: false,
          reasoningUnavailable: false,
          planUnavailable: false,
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
              description: "Custom model description"
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
    );

    openModelReasoningMenu();

    expect(await screen.findByText("复杂编码模型说明")).toBeTruthy();
    expect(
      screen.queryByText(
        "Frontier model for complex coding, research, and real-world work."
      )
    ).toBeNull();
    expect(screen.getByText("Custom model description")).toBeTruthy();
  });
});

const labels = {
  modelLabel: "Model",
  modelSelectionLabel: "Model selection",
  defaultModel: "Default model",
  inheritedUnavailable: "Unavailable",
  loadingSettings: "Loading conversation",
  reasoningLabel: "Reasoning",
  reasoningDegreeLabel: "Reasoning degree",
  reasoningOptionMinimal: "Minimal",
  reasoningOptionLow: "Low",
  reasoningOptionMedium: "Medium",
  reasoningOptionHigh: "High",
  reasoningOptionXHigh: "X High",
  permissionLabel: "Run permissions",
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
