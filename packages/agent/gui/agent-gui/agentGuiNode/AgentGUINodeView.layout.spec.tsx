import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAgentSessionDetailViewModel } from "../../shared/workspaceAgentSessionDetailViewModel";
import type { AgentGUINodeViewModel } from "./model/agentGuiNodeTypes";
import { AgentGUINodeView, type AgentGUIViewLabels } from "./AgentGUINodeView";
import { createLocalAgentGUIProviderTarget } from "../../providerTargets";

const conversationFlowMock = vi.hoisted(() => ({
  calls: [] as Array<{ conversation: unknown; labels: unknown }>
}));

const conversationMetaMock = vi.hoisted(() => ({
  calls: [] as string[]
}));

const composerMock = vi.hoisted(() => ({
  calls: [] as Array<{
    composerFocusRequestSequence?: number | null;
    compactSupported?: boolean | null;
    isSendingTurn?: boolean;
    showStopButton?: boolean;
    usage?: AgentGUINodeViewModel["usage"];
  }>
}));

const workspaceUserProjectI18n = createDefaultWorkspaceUserProjectI18nRuntime();

const statusDotMock = vi.hoisted(() => ({
  calls: [] as Array<{
    ariaLabel?: string;
    pulse?: boolean;
    size?: string;
    title?: string;
    tone?: string;
  }>
}));

vi.mock("./AgentSessionChrome", () => ({
  AgentSessionChrome: () => <div data-testid="agent-session-chrome" />
}));

vi.mock("./AgentComposer", () => ({
  AgentComposer: (props: {
    composerFocusRequestSequence?: number | null;
    compactSupported?: boolean | null;
    isSendingTurn?: boolean;
    showStopButton?: boolean;
    usage?: AgentGUINodeViewModel["usage"];
  }) => {
    composerMock.calls.push({
      composerFocusRequestSequence: props.composerFocusRequestSequence,
      compactSupported: props.compactSupported,
      isSendingTurn: props.isSendingTurn,
      showStopButton: props.showStopButton,
      usage: props.usage
    });
    return <div data-testid="agent-composer" />;
  },
  formatSlashStatusTokenCount: (value: number | null | undefined) =>
    typeof value === "number" ? value.toLocaleString("en-US") : ""
}));

vi.mock(
  "../../shared/agentConversation/components/AgentConversationFlow",
  () => ({
    AgentConversationFlow: ({
      conversation,
      labels
    }: {
      conversation: unknown;
      labels: unknown;
    }) => {
      conversationFlowMock.calls.push({ conversation, labels });
      return <div data-testid="agent-conversation-flow" />;
    }
  })
);

vi.mock("../../app/renderer/components/StatusDot", () => ({
  StatusDot: (props: {
    ariaLabel?: string;
    pulse?: boolean;
    size?: string;
    title?: string;
    tone?: string;
  }) => {
    statusDotMock.calls.push(props);
    return <div data-testid="status-dot" />;
  }
}));

vi.mock("./agentGuiNodeViewConversation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./agentGuiNodeViewConversation")>();
  return {
    ...actual,
    ConversationMeta: (
      props: Parameters<typeof actual.ConversationMeta>[0]
    ): React.JSX.Element => {
      conversationMetaMock.calls.push(props.item.id);
      return actual.ConversationMeta(props);
    }
  };
});

describe("AgentGUINodeView layout persistence", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    conversationMetaMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  it("does not persist the initial layout callback on mount", () => {
    const onConversationRailWidthChanged = vi.fn();

    renderAgentGUINodeView({ onConversationRailWidthChanged });

    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();
  });

  it("ignores rail pointer moves that do not come from the resize handle drag", () => {
    const onConversationRailWidthChanged = vi.fn();

    renderAgentGUINodeView({ onConversationRailWidthChanged });
    fireEvent.pointerMove(
      screen.getByTestId("agent-gui-conversation-rail-resize-handle"),
      { clientX: 640, pointerId: 1 }
    );

    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();
  });

  it("sets the controlled rail width on the grid layout", () => {
    const onConversationRailWidthChanged = vi.fn();

    const { container } = renderAgentGUINodeView({
      conversationRailWidthPx: 320,
      onConversationRailWidthChanged
    });

    const layout = container.querySelector(".agent-gui-node__layout");
    expect(layout).toHaveStyle({
      "--agent-gui-conversation-rail-width": "320px"
    });
    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();
  });

  it("updates the rail width locally while dragging and persists on release", () => {
    const onConversationRailWidthChanged = vi.fn();

    const { container } = renderAgentGUINodeView({
      onConversationRailWidthChanged
    });
    const layout = container.querySelector(".agent-gui-node__layout");
    const resizeHandle = screen.getByTestId(
      "agent-gui-conversation-rail-resize-handle"
    );
    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 0,
      pointerId: 1
    });
    fireEvent.pointerMove(resizeHandle, { clientX: 120, pointerId: 1 });

    expect(layout).toHaveStyle({
      "--agent-gui-conversation-rail-width": "360px"
    });
    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();

    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    expect(onConversationRailWidthChanged).toHaveBeenCalledTimes(1);
    expect(onConversationRailWidthChanged).toHaveBeenCalledWith(360);
  });

  it("keeps the in-flight rail width across parent rerenders", () => {
    const onConversationRailWidthChanged = vi.fn();
    const initialOptions = {
      conversationRailWidthPx: 240,
      onConversationRailWidthChanged
    };

    const { container, rerender } = renderAgentGUINodeView(initialOptions);
    const layout = container.querySelector(".agent-gui-node__layout");
    const resizeHandle = screen.getByTestId(
      "agent-gui-conversation-rail-resize-handle"
    );

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 0,
      pointerId: 1
    });
    fireEvent.pointerMove(resizeHandle, { clientX: 120, pointerId: 1 });
    expect(layout).toHaveStyle({
      "--agent-gui-conversation-rail-width": "360px"
    });

    rerender(buildAgentGUINodeViewElement(initialOptions));

    expect(layout).toHaveStyle({
      "--agent-gui-conversation-rail-width": "360px"
    });

    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });
    expect(onConversationRailWidthChanged).toHaveBeenCalledWith(360);
    expect(layout).toHaveStyle({
      "--agent-gui-conversation-rail-width": "360px"
    });
  });

  it("keeps the rail resize affordance active while dragging", () => {
    const { container } = renderAgentGUINodeView();

    const resizeHandle = screen.getByTestId(
      "agent-gui-conversation-rail-resize-handle"
    );
    const layout = container.querySelector(".agent-gui-node__layout");
    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 0,
      pointerId: 1
    });

    expect(resizeHandle).toHaveAttribute("data-resizing", "true");
    expect(layout).toHaveAttribute("data-rail-resizing", "true");

    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    expect(resizeHandle).not.toHaveAttribute("data-resizing");
    expect(layout).not.toHaveAttribute("data-rail-resizing");
  });

  it("collapses the conversation rail and hides the resize handle when collapsed", () => {
    const onConversationRailWidthChanged = vi.fn();

    renderAgentGUINodeView({
      conversationRailCollapsed: true,
      onConversationRailWidthChanged
    });

    const resizeHandle = screen.getByTestId(
      "agent-gui-conversation-rail-resize-handle"
    );
    expect(resizeHandle).toHaveAttribute("aria-hidden", "true");
    expect(resizeHandle).toHaveClass("pointer-events-none");
    expect(resizeHandle).toHaveClass("opacity-0");
    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();
  });

  it("keeps the conversation search field styled from the carried TSH surface", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__rail-panel\s*\{[^}]*border-right:\s*0;/s
    );
    expect(css).toMatch(
      /\.room-issue-node__search-field\s*{[^}]*position:\s*relative[^}]*min-width:\s*0/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__rail-toolbar\s*\{[^}]*--agent-gui-rail-control-radius:\s*6px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__rail-toolbar\s*\{[^}]*padding:\s*0\s+16px\s+16px;/s
    );
    expect(css).toMatch(
      /\.workbench-window:has\(\s*\[data-agent-gui-workbench-header="true"\]\[data-agent-gui-workbench-header-collapsed="false"\]\s*\)\s*\.agent-gui-node__rail-toolbar\s*{[^}]*padding-top:\s*var\(--agent-gui-workbench-header-height\);/s
    );
    expect(css).toMatch(
      /\.room-issue-node__search-input\s*{[^}]*width:\s*100%[^}]*height:\s*32px\s*!important;[^}]*min-height:\s*32px;[^}]*max-height:\s*32px;[^}]*border:\s*0\s*!important;[^}]*border-radius:\s*var\(--agent-gui-rail-control-radius\)\s*!important;[^}]*font-size:\s*13px\s*!important;[^}]*line-height:\s*18px;[^}]*appearance:\s*none;/s
    );
    expect(css).toMatch(
      /\.room-issue-node__search-clear-button\s*{[^}]*position:\s*absolute[^}]*right:\s*4px[^}]*width:\s*24px/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__new-conversation-icon-button\s*\{[^}]*height:\s*32px;[^}]*min-height:\s*32px;[^}]*max-height:\s*32px;[^}]*border:\s*0\s*!important;[^}]*border-radius:\s*var\(--agent-gui-rail-control-radius\)\s*!important;[^}]*font-size:\s*13px;/s
    );
  });

  it("does not animate the rail resize geometry while dragging", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__layout\[data-rail-resizing="true"\]\s*{[^}]*transition:\s*none/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__rail-resize-handle\[data-resizing="true"\]\s*{[^}]*transition:\s*none/s
    );
  });

  it("uses ui-system ConfirmationDialog for project action confirmations", () => {
    const source = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentGUINodeView.tsx"),
      "utf8"
    );

    expect(source).toMatch(/ConfirmationDialog/);
    expect(source).toMatch(
      /setPendingProjectAction\(\{[\s\S]*kind:\s*"batch-delete"/
    );
    expect(source).toMatch(
      /setPendingProjectAction\(\{[\s\S]*kind:\s*"remove"/
    );
    expect(source).toMatch(
      /onConfirmDeleteProjectConversations\(action\.path\)/
    );
    expect(source).toMatch(/onRemoveProject\(action\.path\)/);
    expect(source).toMatch(/tone="destructive"/);
    expect(source).toMatch(
      /overlayClassName=\{AGENT_GUI_CONFIRMATION_DIALOG_OVERLAY_CLASS_NAME\}/
    );
    expect(source).not.toMatch(/toast\.custom\(/);
    expect(source).not.toMatch(/toast\.warning\(/);
  });

  it("places conversation section create action tooltips above the icon button first", () => {
    const source = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentGUINodeView.tsx"),
      "utf8"
    );

    expect(source).toMatch(
      /<TooltipContent\s+side="top"\s+sideOffset=\{6\}\s+className=\{styles\.conversationSectionActionTooltip\}\s*>\s*\{createConversationLabel\}/
    );
  });

  it("opens a new conversation draft for the selected project section", () => {
    const actions = createActions();
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        conversations: [
          {
            ...createConversationSummary("session-1"),
            cwd: "/workspace/app",
            project: {
              id: "project-app",
              path: "/workspace/app",
              label: "App"
            }
          }
        ]
      },
      labels: {
        ...createLabels(),
        projectSectionEdit: "New session"
      }
    });

    fireEvent.click(screen.getByLabelText("New session"));

    expect(actions.createConversation).toHaveBeenCalledWith({
      projectPath: "/workspace/app",
      source: "project_section"
    });
    expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBe(1);
  });

  it("opens a new conversation draft from the ordinary conversations section", async () => {
    const actions = createActions();
    const conversation = createConversationSummary("session-1");
    const { container } = renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        activeConversation: conversation,
        activeConversationId: conversation.id,
        conversations: [conversation]
      },
      labels: {
        ...createLabels(),
        newConversation: "New session"
      }
    });
    const conversationsSection = container.querySelector(
      '.agent-gui-node__conversation-section[data-kind="conversations"]'
    );
    if (!conversationsSection) {
      throw new Error("Expected conversations section to render.");
    }

    fireEvent.click(
      within(conversationsSection as HTMLElement).getByLabelText("New session")
    );

    expect(actions.createConversation).toHaveBeenCalledWith({
      projectPath: null,
      source: "unscoped_section"
    });
    await waitFor(() => {
      expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBe(1);
    });
  });

  it("opens an ordinary draft from the ordinary section when a project draft is selected", () => {
    const actions = createActions();
    const viewModel = createViewModel();
    const { container } = renderAgentGUINodeView({
      actions,
      viewModel: {
        ...viewModel,
        conversations: [],
        userProjects: [
          {
            id: "project-app",
            path: "/workspace/app",
            label: "App"
          }
        ],
        composerSettings: {
          ...viewModel.composerSettings,
          selectedProjectPath: "/workspace/app"
        }
      },
      labels: {
        ...createLabels(),
        newConversation: "New session"
      }
    });
    const conversationsSection = container.querySelector(
      '.agent-gui-node__conversation-section[data-kind="conversations"]'
    );
    if (!conversationsSection) {
      throw new Error("Expected conversations section to render.");
    }

    fireEvent.click(
      within(conversationsSection as HTMLElement).getByLabelText("New session")
    );

    expect(actions.createConversation).toHaveBeenCalledWith({
      projectPath: null,
      source: "unscoped_section"
    });
  });

  it("opens an empty selected project draft from the toolbar new conversation action", () => {
    const actions = createActions();
    const viewModel = createViewModel();
    const { container } = renderAgentGUINodeView({
      actions,
      viewModel: {
        ...viewModel,
        conversations: [],
        userProjects: [
          {
            id: "project-app",
            path: "/workspace/app",
            label: "App"
          }
        ],
        composerSettings: {
          ...viewModel.composerSettings,
          selectedProjectPath: "/workspace/app"
        }
      }
    });
    const newConversationButton = container.querySelector<HTMLButtonElement>(
      ".agent-gui-node__new-conversation-icon-button"
    );
    if (!newConversationButton) {
      throw new Error("Expected toolbar new conversation button to render.");
    }
    expect(newConversationButton).toHaveAttribute("data-size", "dialog");
    expect(
      newConversationButton.querySelector("path")?.getAttribute("d")
    ).toContain("M20 2C20.7957 2");

    fireEvent.click(newConversationButton);

    expect(actions.createConversation).toHaveBeenCalledWith({
      projectPath: "/workspace/app",
      source: "selected_project"
    });
    expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBe(1);
  });

  it("keeps ordinary conversation section actions hover and focus discoverable", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-more-button\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section:hover\s+\.agent-gui-node__conversation-section-more-button,[\s\S]*?\.agent-gui-node__conversation-section:focus-within\s+\.agent-gui-node__conversation-section-more-button,[\s\S]*?\.agent-gui-node__conversation-section-more-button\[aria-expanded="true"\s*\]\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section\[data-kind="conversations"\]\s+\.agent-gui-node__conversation-section-actions\s*\{[^}]*min-width:\s*0;/s
    );
  });

  it("defers rendering conversation items for collapsed project sections", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [
          {
            ...createConversationSummary("session-1"),
            cwd: "/workspace/app",
            project: {
              id: "project-app",
              path: "/workspace/app",
              label: "App"
            }
          }
        ]
      }
    });

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /App/u }));

    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-1")
    ).toBeNull();
    expect(screen.getByRole("button", { name: /App/u })).toBeInTheDocument();
  });

  it("opens project folders through the workspace files action", async () => {
    const actions = createActions();
    const onLinkAction = vi.fn();
    renderAgentGUINodeView({
      actions,
      onLinkAction,
      viewModel: {
        ...createViewModel(),
        conversations: [
          {
            ...createConversationSummary("session-1"),
            cwd: "/workspace/app",
            project: {
              id: "project-app",
              path: "/workspace/app",
              label: "App"
            }
          }
        ]
      },
      labels: {
        ...createLabels(),
        projectSectionMoreActions: "Project actions",
        projectSectionViewFiles: "Open folder"
      }
    });

    const projectActionsButton = screen.getByLabelText("Project actions");
    fireEvent.pointerDown(projectActionsButton, { button: 0, ctrlKey: false });
    fireEvent.click(projectActionsButton);
    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems[0]).toHaveTextContent("Open folder");

    fireEvent.click(screen.getByText("Open folder"));

    expect(onLinkAction).toHaveBeenCalledWith({
      directoryPath: "/workspace/app",
      mode: "open-directory",
      path: "/workspace/app",
      source: "agent-project-menu",
      type: "open-workspace-file",
      workspaceRoot: "/workspace/app"
    });
  });

  it("shows tooltips for project section icon actions", () => {
    const { container } = renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        userProjects: [
          {
            id: "project-app",
            path: "/workspace/app",
            label: "App"
          }
        ]
      }
    });
    const projectSection = container.querySelector(
      '.agent-gui-node__conversation-section[data-kind="project"]'
    );
    if (!projectSection) {
      throw new Error("Expected project section to render.");
    }

    const tooltipTriggers = Array.from(
      projectSection.querySelectorAll(
        ".agent-gui-node__conversation-section-action-tooltip-wrap"
      )
    );

    expect(tooltipTriggers).toHaveLength(2);
    expect(
      projectSection.querySelector(
        ".agent-gui-node__conversation-section-action-tooltip"
      )
    ).toBeNull();

    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    expect(css).toMatch(
      /\.agent-gui-node__rail-panel\s*\{[^}]*overflow:\s*visible;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__conversation-section-action-tooltip\s*\{[^}]*max-width:\s*180px;[^}]*white-space:\s*nowrap;/s
    );
  });

  it("shows empty project sections when projects have no conversations", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        userProjects: [
          {
            id: "project-app",
            path: "/workspace/app",
            label: "App"
          }
        ]
      },
      labels: {
        ...createLabels(),
        emptyProjectConversations: "No chats yet"
      }
    });

    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("sectionConversations")).toBeInTheDocument();
    expect(screen.getAllByText("No chats yet")).toHaveLength(2);
    expect(screen.queryByText("noConversations")).not.toBeInTheDocument();
  });

  it("hides batch delete from empty project section actions", async () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        userProjects: [
          {
            id: "project-app",
            path: "/workspace/app",
            label: "App"
          }
        ]
      }
    });

    const moreActionsButton = screen.getByRole("button", {
      name: "projectSectionMoreActions"
    });
    fireEvent.pointerDown(moreActionsButton);
    fireEvent.click(moreActionsButton);

    expect(screen.queryByText("batchDeleteProjectSessions")).toBeNull();
    expect(await screen.findByText("removeProject")).toBeInTheDocument();
  });

  it("shows a tooltip trigger for the active conversation run path", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation: {
          ...createConversationSummary("session-1"),
          cwd: "/workspace/demo"
        },
        activeConversationId: "session-1"
      }
    });

    expect(
      screen.getByRole("button", { name: "/workspace/demo" })
    ).toHaveAttribute("data-slot", "tooltip-trigger");
  });

  it("renders a fishbone loading skeleton for the initial conversation list load", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        isLoadingConversations: true
      }
    });

    expect(
      screen.getByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toHaveAccessibleName("loadingConversations");
    expect(screen.queryByText("loadingConversations")).not.toBeInTheDocument();
  });

  it("opens a conversation from the rail with the external-link action", () => {
    const actions = createActions();
    const onOpenConversationWindow = vi.fn();

    renderAgentGUINodeView({
      actions,
      onOpenConversationWindow,
      viewModel: {
        ...createViewModel(),
        activeConversationId: "session-1",
        conversations: [
          createConversationSummary("session-1"),
          createConversationSummary("session-2")
        ]
      }
    });

    const row = screen.getByTestId("agent-gui-conversation-item-session-2");
    const openWindowButton = within(row).getByRole("button", {
      name: "openConversationWindow"
    });

    expect(
      openWindowButton.querySelector("svg.lucide-external-link")
    ).toBeInTheDocument();

    fireEvent.click(openWindowButton);

    expect(onOpenConversationWindow).toHaveBeenCalledTimes(1);
    expect(onOpenConversationWindow).toHaveBeenCalledWith("session-2");
    expect(actions.selectConversation).not.toHaveBeenCalled();
  });

  it("pages each conversation rail section five sessions at a time", () => {
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more",
        showLessConversations: "Show less"
      },
      viewModel: {
        ...createViewModel(),
        conversations: Array.from({ length: 12 }, (_, index) =>
          createConversationSummary(`session-${index + 1}`)
        )
      }
    });

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-5")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-6")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show less" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-10")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-11")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show more" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show less" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-5")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-6")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show less" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-12")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show more" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show less" })
    ).toBeInTheDocument();
  });

  it("does not rerender the conversation rail when only the active detail state changes", () => {
    const actions = createActions();
    const labels = createLabels();
    const viewModel = {
      ...createViewModel(),
      conversations: Array.from({ length: 20 }, (_, index) =>
        createConversationSummary(`session-${index + 1}`)
      )
    };
    const initialOptions = {
      actions,
      isActive: true,
      labels,
      viewModel
    };

    const { rerender } = renderAgentGUINodeView(initialOptions);

    expect(conversationMetaMock.calls).toHaveLength(5);
    conversationMetaMock.calls = [];

    rerender(
      buildAgentGUINodeViewElement({
        ...initialOptions,
        isActive: false
      })
    );

    expect(conversationMetaMock.calls).toHaveLength(0);
  });

  it("scrolls the active conversation item into view", () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const activeConversation = createConversationSummary("session-2");
      renderAgentGUINodeView({
        viewModel: {
          ...createViewModel(),
          conversations: [
            createConversationSummary("session-1"),
            activeConversation
          ],
          activeConversation,
          activeConversationId: "session-2"
        }
      });

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("does not re-scroll the active conversation when only conversation metadata changes", () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const firstConversation = createConversationSummary("session-1");
      const activeConversation = createConversationSummary("session-2");
      const viewModel = {
        ...createViewModel(),
        conversations: [firstConversation, activeConversation],
        activeConversation,
        activeConversationId: "session-2"
      };
      const { rerender } = renderAgentGUINodeView({ viewModel });

      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      const updatedActiveConversation = {
        ...activeConversation,
        status: "working" as const,
        updatedAtUnixMs: activeConversation.updatedAtUnixMs + 1_000
      };
      rerender(
        <AgentGUINodeView
          viewModel={{
            ...viewModel,
            conversations: [firstConversation, updatedActiveConversation],
            activeConversation: updatedActiveConversation
          }}
          isAgentProviderReady={true}
          actions={createActions()}
          conversationRailCollapsed={false}
          conversationRailWidthPx={240}
          conversationRailMinWidthPx={220}
          conversationRailMaxWidthPx={420}
          detailMinWidthPx={220}
          uiLanguage="en"
          onConversationRailWidthChanged={vi.fn()}
          labels={createLabels()}
          workspaceUserProjectI18n={workspaceUserProjectI18n}
        />
      );

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it("keeps projected conversation and transcript labels stable across unrelated rerenders", () => {
    const viewModel = {
      ...createViewModel(),
      activeConversation: createConversationSummary("session-1"),
      activeConversationId: "session-1",
      conversationDetail: createConversationDetail()
    };
    const actions = createActions();
    const labels = createLabels();
    const onConversationRailWidthChanged = vi.fn();

    const { rerender } = renderAgentGUINodeView({
      conversationRailWidthPx: 240,
      onConversationRailWidthChanged,
      viewModel,
      actions,
      labels
    });
    const firstCall = conversationFlowMock.calls.at(-1);

    rerender(
      <AgentGUINodeView
        viewModel={viewModel}
        actions={actions}
        isAgentProviderReady={true}
        conversationRailCollapsed={false}
        conversationRailWidthPx={320}
        conversationRailMinWidthPx={220}
        conversationRailMaxWidthPx={420}
        detailMinWidthPx={220}
        uiLanguage="en"
        onConversationRailWidthChanged={onConversationRailWidthChanged}
        labels={labels}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
      />
    );
    const secondCall = conversationFlowMock.calls.at(-1);

    expect(firstCall?.conversation).toBeTruthy();
    expect(secondCall?.conversation).toBe(firstCall?.conversation);
    expect(secondCall?.labels).toBe(firstCall?.labels);
  });

  it("does not rerender the conversation detail flow when filtering the rail list", () => {
    const viewModel = {
      ...createViewModel(),
      conversations: [
        createConversationSummary("session-1"),
        createConversationSummary("session-2")
      ],
      activeConversation: createConversationSummary("session-1"),
      activeConversationId: "session-1",
      conversationDetail: createConversationDetail()
    };

    renderAgentGUINodeView({ viewModel });
    const initialRenderCount = conversationFlowMock.calls.length;

    fireEvent.change(
      screen.getByRole("searchbox", { name: "searchPlaceholder" }),
      {
        target: { value: "session-2" }
      }
    );

    expect(conversationFlowMock.calls).toHaveLength(initialRenderCount);
  });

  it("does not rerender the conversation detail flow when detail chrome state changes", () => {
    const viewModel = {
      ...createViewModel(),
      activeConversation: createConversationSummary("session-1"),
      activeConversationId: "session-1",
      conversationDetail: createConversationDetail()
    };
    const actions = createActions();
    const labels = createLabels();
    const onConversationRailWidthChanged = vi.fn();

    const { rerender } = renderAgentGUINodeView({
      viewModel,
      actions,
      labels,
      onConversationRailWidthChanged
    });
    const initialRenderCount = conversationFlowMock.calls.length;

    rerender(
      <AgentGUINodeView
        viewModel={{
          ...viewModel,
          inlineNotice: {
            id: "notice-1",
            message: "detail failed",
            tone: "error",
            autoDismissMs: null
          }
        }}
        actions={actions}
        isAgentProviderReady={true}
        conversationRailCollapsed={false}
        conversationRailWidthPx={240}
        conversationRailMinWidthPx={220}
        conversationRailMaxWidthPx={420}
        detailMinWidthPx={220}
        uiLanguage="en"
        onConversationRailWidthChanged={onConversationRailWidthChanged}
        labels={labels}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
      />
    );

    expect(conversationFlowMock.calls).toHaveLength(initialRenderCount);
  });

  it("does not rerender the conversation detail flow when detail header status changes", () => {
    const viewModel = {
      ...createViewModel(),
      activeConversation: createConversationSummary("session-1"),
      activeConversationId: "session-1",
      conversationDetail: createConversationDetail()
    };
    const actions = createActions();
    const labels = createLabels();
    const onConversationRailWidthChanged = vi.fn();

    const { rerender } = renderAgentGUINodeView({
      viewModel,
      actions,
      labels,
      onConversationRailWidthChanged
    });
    const initialRenderCount = conversationFlowMock.calls.length;

    rerender(
      <AgentGUINodeView
        viewModel={{
          ...viewModel,
          activeConversation: {
            ...viewModel.activeConversation!,
            status: "working"
          }
        }}
        actions={actions}
        isAgentProviderReady={true}
        conversationRailCollapsed={false}
        conversationRailWidthPx={240}
        conversationRailMinWidthPx={220}
        conversationRailMaxWidthPx={420}
        detailMinWidthPx={220}
        uiLanguage="en"
        onConversationRailWidthChanged={onConversationRailWidthChanged}
        labels={labels}
        workspaceUserProjectI18n={workspaceUserProjectI18n}
      />
    );

    expect(conversationFlowMock.calls).toHaveLength(initialRenderCount);
  });

  it("hides the detail conversation status indicator and label", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation: {
          ...createConversationSummary("session-1"),
          status: "working"
        },
        activeConversationId: "session-1",
        conversations: [
          {
            ...createConversationSummary("session-1"),
            status: "working"
          }
        ]
      }
    });

    expect(screen.queryByText("statusReady")).not.toBeInTheDocument();
    expect(screen.queryByText("statusWorking")).not.toBeInTheDocument();
    expect(statusDotMock.calls).not.toContainEqual(
      expect.objectContaining({ ariaLabel: "statusReady" })
    );
    expect(statusDotMock.calls).not.toContainEqual(
      expect.objectContaining({ ariaLabel: "statusWorking" })
    );
  });

  it("marks the composer as sending while the active conversation turn is working", () => {
    const activeConversation = {
      ...createConversationSummary("session-1"),
      status: "working" as const
    };

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail(),
        isSubmitting: false
      }
    });

    expect(composerMock.calls.at(-1)).toMatchObject({
      isSendingTurn: true,
      showStopButton: true
    });
  });

  it("derives the visible busy state from active detail when the summary is stale", () => {
    const activeConversation = createConversationSummary("session-1");

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail(),
        isSubmitting: false
      }
    });

    expect(screen.queryByText("statusWorking")).not.toBeInTheDocument();
    expect(composerMock.calls.at(-1)).toMatchObject({
      isSendingTurn: true,
      showStopButton: true
    });
  });

  it("shows the active conversation as working while a prompt submit is pending", () => {
    const activeConversation = createConversationSummary("session-1");

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail(),
        isSubmitting: true
      }
    });

    expect(screen.queryByText("statusWorking")).not.toBeInTheDocument();
    expect(composerMock.calls.at(-1)).toMatchObject({
      isSendingTurn: true,
      showStopButton: false
    });
  });

  it("does not reserve bottom dock height inside the timeline scroll area", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation: createConversationSummary("session-1"),
        activeConversationId: "session-1",
        conversationDetail: createConversationDetail()
      }
    });

    expect(
      screen
        .getByTestId("agent-gui-timeline")
        .style.getPropertyValue("--agent-gui-bottom-dock-height")
    ).toBe("");
  });

  it("uses shared vertical scrollbars for the conversation list and timeline", () => {
    const activeConversation = createConversationSummary("session-1");
    const { container } = renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [activeConversation],
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail()
      }
    });

    const conversationList = container.querySelector(
      ".agent-gui-node__conversation-list"
    );
    const conversationListScrollArea = conversationList?.closest(
      "[data-slot='scroll-area']"
    );
    const timelineScrollArea = screen
      .getByTestId("agent-gui-timeline")
      .closest("[data-slot='scroll-area']");

    expect(conversationListScrollArea).not.toBeNull();
    expect(timelineScrollArea).not.toBeNull();
    expect(conversationList).toHaveAttribute(
      "data-slot",
      "scroll-area-viewport"
    );
    expect(screen.getByTestId("agent-gui-timeline")).toHaveAttribute(
      "data-slot",
      "scroll-area-viewport"
    );
  });

  it("renders the timeline scroll content as a grid with transcript row gap", () => {
    const activeConversation = createConversationSummary("session-1");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [activeConversation],
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail()
      }
    });

    const timelineContent = screen.getByTestId("agent-gui-timeline")
      .firstElementChild as HTMLElement | null;

    expect(timelineContent).not.toBeNull();
    expect(timelineContent).toHaveStyle({
      minWidth: "100%",
      display: "grid",
      gap: "24px"
    });
  });

  it("renders older-message loading above the transcript", () => {
    const activeConversation = createConversationSummary("session-1");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [activeConversation],
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail(),
        isLoadingOlderMessages: true
      }
    });

    const loading = screen.getByTestId("agent-gui-older-messages-loading");
    expect(loading).toHaveTextContent("loadingConversation");
    expect(screen.getByTestId("agent-conversation-flow")).toBeInTheDocument();
  });

  it("prefetches older messages near the top and preserves the prepend anchor", () => {
    const activeConversation = createConversationSummary("session-1");
    const actions = createActions();
    const activeViewModel = {
      ...createViewModel(),
      conversations: [activeConversation],
      activeConversation,
      activeConversationId: activeConversation.id,
      conversationDetail: createConversationDetail()
    };
    const { rerender } = renderAgentGUINodeView({
      actions,
      viewModel: activeViewModel
    });
    const timeline = screen.getByTestId("agent-gui-timeline") as HTMLElement;
    let scrollHeight = 1000;
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight
    });
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      get: () => 400
    });

    timeline.scrollTop = 500;
    rerender(
      buildAgentGUINodeViewElement({
        actions,
        viewModel: { ...activeViewModel, hasOlderMessages: true }
      })
    );
    expect(actions.loadOlderConversationMessages).not.toHaveBeenCalled();

    timeline.scrollTop = 200;
    fireEvent.scroll(timeline);
    expect(actions.loadOlderConversationMessages).toHaveBeenCalledTimes(1);

    scrollHeight = 1032;
    rerender(
      buildAgentGUINodeViewElement({
        actions,
        viewModel: {
          ...activeViewModel,
          hasOlderMessages: true,
          isLoadingOlderMessages: true
        }
      })
    );
    expect(timeline.scrollTop).toBe(232);

    scrollHeight = 1200;
    rerender(
      buildAgentGUINodeViewElement({
        actions,
        viewModel: { ...activeViewModel, hasOlderMessages: true }
      })
    );
    expect(timeline.scrollTop).toBe(400);
  });
});

describe("AgentGUINodeView usage", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  function renderWithUsage(
    usage: AgentGUINodeViewModel["usage"],
    slashStatusLimits: AgentGUINodeViewProps["slashStatusLimits"] = []
  ) {
    const activeConversation = createConversationSummary("session-1");
    return renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [activeConversation],
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail(),
        usage
      },
      slashStatusLimits
    });
  }

  it("passes context usage to the composer", () => {
    renderWithUsage({
      usedTokens: 50_000,
      totalTokens: 200_000,
      percentUsed: 25,
      quotas: []
    });

    expect(composerMock.calls.at(-1)?.usage).toMatchObject({
      usedTokens: 50_000,
      totalTokens: 200_000,
      percentUsed: 25
    });
  });

  it("passes warning-level usage to the composer", () => {
    renderWithUsage({
      usedTokens: 170_000,
      totalTokens: 200_000,
      percentUsed: 85,
      quotas: []
    });

    expect(composerMock.calls.at(-1)?.usage?.percentUsed).toBe(85);
  });

  it("passes critical-level usage to the composer", () => {
    renderWithUsage({
      usedTokens: 194_000,
      totalTokens: 200_000,
      percentUsed: 97,
      quotas: []
    });

    expect(composerMock.calls.at(-1)?.usage?.percentUsed).toBe(97);
  });

  it("passes null usage to the composer", () => {
    renderWithUsage(null);

    expect(composerMock.calls.at(-1)?.usage).toBeNull();
  });

  it("passes unavailable usage to the composer", () => {
    renderWithUsage({
      usedTokens: null,
      totalTokens: null,
      percentUsed: null,
      quotas: [{ quotaType: "weekly", percentRemaining: 90 }]
    });

    expect(composerMock.calls.at(-1)?.usage?.percentUsed).toBeNull();
  });
});

describe("AgentGUINodeView detail header actions", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  const usageWithWindow: AgentGUINodeViewModel["usage"] = {
    usedTokens: 170_000,
    totalTokens: 200_000,
    percentUsed: 85,
    quotas: []
  };

  function headerActionViewModel(): AgentGUINodeViewModel {
    const activeConversation = {
      ...createConversationSummary("session-1"),
      status: "working" as const
    };
    const conversationDetail = createConversationDetail();
    return {
      ...createViewModel(),
      conversations: [activeConversation],
      activeConversation,
      activeConversationId: activeConversation.id,
      conversationDetail: {
        ...conversationDetail,
        session: {
          ...conversationDetail.session,
          effectiveStatus: "working",
          turnPhase: "working"
        }
      },
      usage: usageWithWindow,
      compactSupported: true
    };
  }

  it("does not render compact or working status controls in the detail header", () => {
    renderAgentGUINodeView({ viewModel: headerActionViewModel() });

    expect(composerMock.calls.at(-1)?.usage).toMatchObject(usageWithWindow);
    // The bottom-dock composer (active conversation) must receive
    // compactSupported so its usage popover can render the compact button.
    expect(composerMock.calls.at(-1)?.compactSupported).toBe(true);
    expect(screen.queryByTestId("agent-gui-compact-button")).toBeNull();
    expect(statusDotMock.calls).not.toContainEqual(
      expect.objectContaining({
        ariaLabel: "workingLabel"
      })
    );
  });
});

describe("AgentGUINodeView provider setup notice", () => {
  it("renders a visible setup notice when the provider is not ready", () => {
    renderAgentGUINodeView({ isAgentProviderReady: false });

    const notice = screen.getByTestId("agent-gui-provider-setup-notice");
    expect(notice).toHaveTextContent("installRequiredPlaceholder");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveAttribute("data-slot", "toast");
    expect(
      screen.getByTestId("agent-gui-provider-setup-notice-action")
    ).toHaveTextContent("installRequiredAction");
  });

  it("floats the setup notice above the detail content without affecting layout", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const setupNoticeRule = css.match(
      /\.agent-gui-node__provider-setup-notice\s*{[^}]*}/s
    )?.[0];

    expect(setupNoticeRule).toContain("position: absolute;");
    expect(setupNoticeRule).toContain("top: 8px;");
    // Horizontally centered above the detail content.
    expect(setupNoticeRule).toContain("left: 50%;");
    expect(setupNoticeRule).toContain("transform: translateX(-50%);");
    expect(setupNoticeRule).toContain("z-index: 2;");
    expect(setupNoticeRule).toContain("width: max-content;");
    // Message text and the "Set up" action must not butt together.
    expect(setupNoticeRule).toContain("column-gap: 6px;");
    expect(setupNoticeRule).toMatch(
      /max-width:\s*min\(\s*calc\(100% - \(var\(--agent-gui-detail-padding-x\) \* 2\)\),\s*420px\s*\);/s
    );
    expect(setupNoticeRule).toContain("margin: 0;");
    expect(setupNoticeRule).not.toContain("background:");
    expect(css).toContain(
      ".agent-gui-node__detail-header + .agent-gui-node__provider-setup-notice"
    );
    expect(css).toContain("top: calc(64px + 4px);");
  });

  it("hides the setup notice when the provider is ready", () => {
    renderAgentGUINodeView({ isAgentProviderReady: true });

    expect(screen.queryByTestId("agent-gui-provider-setup-notice")).toBeNull();
  });
});

describe("AgentGUINodeView usage alert banner", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  it("does not render a composer banner for context usage alerts", () => {
    const activeConversation = createConversationSummary("session-1");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [activeConversation],
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail(),
        usage: {
          usedTokens: 194_000,
          totalTokens: 200_000,
          percentUsed: 97,
          quotas: []
        },
        compactSupported: true
      }
    });

    expect(screen.queryByTestId("agent-gui-usage-alert")).toBeNull();
    expect(screen.queryByTestId("agent-gui-usage-alert-compact")).toBeNull();
  });
});

interface RenderAgentGUINodeViewOptions {
  conversationRailCollapsed?: boolean;
  conversationRailWidthPx?: number;
  isActive?: boolean;
  isAgentProviderReady?: boolean;
  onConversationRailWidthChanged?: (widthPx: number) => void;
  onLinkAction?: AgentGUINodeViewProps["onLinkAction"];
  viewModel?: AgentGUINodeViewModel;
  actions?: AgentGUINodeViewProps["actions"];
  labels?: AgentGUIViewLabels;
  onOpenConversationWindow?: AgentGUINodeViewProps["onOpenConversationWindow"];
  slashStatusLimits?: AgentGUINodeViewProps["slashStatusLimits"];
}

function buildAgentGUINodeViewElement({
  conversationRailCollapsed = false,
  conversationRailWidthPx = 240,
  isActive = true,
  isAgentProviderReady = true,
  onConversationRailWidthChanged = vi.fn(),
  onLinkAction,
  viewModel = createViewModel(),
  actions = createActions(),
  labels = createLabels(),
  onOpenConversationWindow,
  slashStatusLimits = []
}: RenderAgentGUINodeViewOptions = {}) {
  return (
    <AgentGUINodeView
      viewModel={viewModel}
      onLinkAction={onLinkAction}
      isActive={isActive}
      isAgentProviderReady={isAgentProviderReady}
      slashStatusLimits={slashStatusLimits}
      actions={actions}
      workspaceUserProjectI18n={workspaceUserProjectI18n}
      conversationRailCollapsed={conversationRailCollapsed}
      conversationRailWidthPx={conversationRailWidthPx}
      conversationRailMinWidthPx={220}
      conversationRailMaxWidthPx={420}
      detailMinWidthPx={220}
      uiLanguage="en"
      onOpenConversationWindow={onOpenConversationWindow}
      onConversationRailWidthChanged={onConversationRailWidthChanged}
      labels={labels}
    />
  );
}

function renderAgentGUINodeView(options: RenderAgentGUINodeViewOptions = {}) {
  return render(buildAgentGUINodeViewElement(options));
}

type AgentGUINodeViewProps = Parameters<typeof AgentGUINodeView>[0];

function createActions(): AgentGUINodeViewProps["actions"] {
  return {
    createConversation: vi.fn(),
    selectConversation: vi.fn(),
    submitPrompt: vi.fn(),
    loadOlderConversationMessages: vi.fn(),
    showPromptImagesUnsupported: vi.fn(),
    submitApprovalOption: vi.fn(),
    submitInteractivePrompt: vi.fn(),
    interruptCurrentTurn: vi.fn(),
    updateDraftContent: vi.fn(),
    updateComposerSettings: vi.fn(),
    sendQueuedPromptNext: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    editQueuedPrompt: vi.fn(),
    retryActivation: vi.fn(),
    continueInNewConversation: vi.fn(),
    retryOpenclawGateway: vi.fn(),
    toggleConversationPinned: vi.fn(),
    removeProject: vi.fn(),
    confirmDeleteProjectConversations: vi.fn(),
    requestDeleteConversation: vi.fn(),
    cancelDeleteConversation: vi.fn(),
    confirmDeleteConversation: vi.fn()
  };
}

function createViewModel(): AgentGUINodeViewModel {
  return {
    workspaceId: "room-1",
    data: {
      provider: "codex",
      lastActiveAgentSessionId: null,
      conversationRailWidthPx: null
    },
    selectedProviderTarget: createLocalAgentGUIProviderTarget("codex"),
    conversations: [],
    userProjects: [],
    activeConversation: null,
    activeConversationId: null,
    availableCommands: [],
    availableSkills: [],
    draftPrompt: "",
    draftContent: { prompt: "", images: [] },
    isLoadingConversations: false,
    isLoadingMessages: false,
    isLoadingOlderMessages: false,
    hasOlderMessages: false,
    isCreatingConversation: false,
    isSubmitting: false,
    isInterrupting: false,
    isCancelPending: false,
    isRespondingApproval: false,
    promptImagesSupported: true,
    compactSupported: null,
    usage: null,
    listError: null,
    isDeletingConversation: false,
    isDeletingProjectConversations: false,
    pendingDeleteConversation: null,
    pendingDeleteProjectConversations: null,
    pendingApproval: null,
    pendingInteractivePrompt: null,
    activeLiveState: "inactive",
    activationError: null,
    openclawGateway: null,
    canSubmit: true,
    hasSentUserMessage: false,
    composerSettings: {
      sessionSettings: null,
      draftSettings: {
        model: null,
        reasoningEffort: null,
        speed: null,
        planMode: false,
        browserUse: true,
        permissionModeId: "preset"
      },
      supportsModel: false,
      supportsReasoningEffort: false,
      supportsSpeed: false,
      speedUnavailable: false,
      availableSpeeds: [],
      supportsPlanMode: false,
      isSettingsLoading: false,
      modelUnavailable: false,
      reasoningUnavailable: false,
      availableModels: [],
      availableReasoningEfforts: []
    },
    queuedPrompts: [],
    drainingQueuedPromptId: null,
    canQueueWhileBusy: false,
    avoidGroupingEdits: false,
    conversation: null,
    conversationDetail: null,
    sessionChrome: {
      auth: null,
      approval: null,
      recovery: null,
      rawState: null
    },
    inlineNotice: null
  };
}

function createConversationSummary(
  id: string
): AgentGUINodeViewModel["conversations"][number] {
  return {
    id,
    provider: "codex",
    title: id,
    status: "ready",
    cwd: "/workspace",
    updatedAtUnixMs: Date.now()
  };
}

function createConversationDetail(): WorkspaceAgentSessionDetailViewModel {
  return {
    activity: {
      id: "activity-1",
      sessionId: "session-1",
      agentName: "Codex",
      agentProvider: "codex",
      status: "working",
      title: "Codex",
      latestActivitySummary: "Working",
      sortTimeUnixMs: 10,
      changedFiles: [],
      userId: "user-1",
      userName: "Taylor",
      userAvatarUrl: ""
    },
    session: {
      id: 1,
      presenceId: 1,
      agentSessionId: "session-1",
      providerSessionId: "provider-session-1",
      cwd: "/workspace/demo",
      effectiveStatus: "working",
      turnPhase: "working"
    },
    cwd: "/workspace/demo",
    workspaceRoot: "/workspace",
    turns: [
      {
        id: "turn-1",
        userMessage: { id: "user-1", body: "Hello", turnId: "turn-1" },
        userMessages: [{ id: "user-1", body: "Hello", turnId: "turn-1" }],
        agentMessages: [{ id: "assistant-1", body: "World", turnId: "turn-1" }],
        toolCalls: [],
        toolCallCount: 0,
        hasFailedToolCall: false,
        agentItems: [
          {
            kind: "message",
            message: { id: "assistant-1", body: "World", turnId: "turn-1" }
          }
        ]
      }
    ],
    showProcessingIndicator: false
  };
}

function createLabels(): AgentGUIViewLabels {
  return {
    initialPlaceholder: "initialPlaceholder",
    followupPlaceholder: "followupPlaceholder",
    installRequiredPlaceholder: "installRequiredPlaceholder",
    installRequiredAction: "installRequiredAction",
    collaboratorSessionReadOnlyPlaceholder:
      "collaboratorSessionReadOnlyPlaceholder",
    send: "send",
    modelLabel: "model",
    modelSelectionLabel: "modelSelectionLabel",
    modelContextWindowSuffix: "context window",
    modelTooltipVersionLabel: "Version",
    defaultModel: "defaultModel",
    loadingOptions: "loadingOptions",
    inheritedUnavailable: "inheritedUnavailable",
    reasoningLabel: "reasoning",
    reasoningDegreeLabel: "reasoningDegreeLabel",
    reasoningOptionDefault: "reasoningOptionDefault",
    reasoningOptionMinimal: "reasoningOptionMinimal",
    reasoningOptionLow: "reasoningOptionLow",
    reasoningOptionMedium: "reasoningOptionMedium",
    reasoningOptionHigh: "reasoningOptionHigh",
    reasoningOptionXHigh: "reasoningOptionXHigh",
    reasoningOptionMax: "reasoningOptionMax",
    speedLabel: "Speed",
    speedSelectionLabel: "Speed",
    speedOptionStandard: "Standard",
    speedOptionStandardDescription: "Standard speed",
    speedOptionFast: "Fast",
    speedOptionFastDescription: "Fast speed",
    permissionLabel: "permissionLabel",
    permissionModeReadOnly: "permissionModeReadOnly",
    permissionModeAuto: "permissionModeAuto",
    permissionModeFullAccess: "permissionModeFullAccess",
    modelDescriptions: {
      frontierComplexCoding: "frontierComplexCoding",
      everydayCoding: "everydayCoding",
      smallFastCostEfficient: "smallFastCostEfficient",
      codingOptimized: "codingOptimized",
      ultraFastCoding: "ultraFastCoding",
      professionalLongRunning: "professionalLongRunning"
    },
    openclawGatewayStarting: "openclawGatewayStarting",
    openclawGatewayFailed: "openclawGatewayFailed",
    openclawGatewayRetry: "openclawGatewayRetry",
    planModeLabel: "planMode",
    planModeOnLabel: "on",
    planModeOffLabel: "off",
    planUnavailable: "planUnavailable",
    queuedLabel: "queuedLabel",
    sendQueuedPromptNext: "sendQueuedPromptNext",
    editQueuedPrompt: "editQueuedPrompt",
    deleteQueuedPrompt: "deleteQueuedPrompt",
    queuedPromptMoreActions: "queuedPromptMoreActions",
    stop: "stop",
    stopping: "stopping",
    noRunningResponse: "noRunningResponse",
    promptTipsPrefix: "Tips：",
    promptTips: [],
    reviewPicker: {
      title: "代码审查",
      targetLabel: "审查范围",
      searchPlaceholder: "搜索",
      noResults: "无匹配结果",
      uncommitted: "未提交的更改",
      baseBranch: "与分支比较",
      commit: "指定提交",
      custom: "自定义说明",
      branchLabel: "基准分支",
      branchPlaceholder: "选择分支",
      branchLoading: "正在加载分支…",
      branchEmpty: "未找到分支",
      commitPlaceholder: "提交 SHA",
      customPlaceholder: "描述要审查的内容",
      submit: "开始审查",
      cancel: "取消"
    },
    empty: "empty",
    conversations: "conversations",
    newConversation: "newConversation",
    agentConfig: "agentConfig",
    agentEnvSetup: "agentEnvSetup",
    noConversations: "noConversations",
    emptyProjectConversations: "emptyProjectConversations",
    startConversation: "startConversation",
    selectConversation: "selectConversation",
    loadingConversations: "loadingConversations",
    loadingConversation: "loadingConversation",
    searchNoConversations: "searchNoConversations",
    conversationUnavailable: "conversationUnavailable",
    fallbackAgentTitle: "Agent",
    searchPlaceholder: "searchPlaceholder",
    sectionPinned: "sectionPinned",
    sectionConversations: "sectionConversations",
    sectionToday: "sectionToday",
    sectionYesterday: "sectionYesterday",
    sectionEarlier: "sectionEarlier",
    projectSectionEdit: "projectSectionEdit",
    projectSectionMoreActions: "projectSectionMoreActions",
    projectSectionViewFiles: "projectSectionViewFiles",
    projectRailCreateProject: "projectRailCreateProject",
    projectRailLinkExistingProject: "projectRailLinkExistingProject",
    removeProject: "removeProject",
    removeProjectConfirmDescription: (projectLabel: string) =>
      `removeProjectConfirmDescription:${projectLabel}`,
    removeProjectConfirmTitle: "removeProjectConfirmTitle",
    batchDeleteProjectSessions: "batchDeleteProjectSessions",
    batchDeleteProjectSessionsTitle: "batchDeleteProjectSessionsTitle",
    batchDeleteProjectSessionsBody: (count: number, project: string) =>
      `batchDeleteProjectSessionsBody:${count}:${project}`,
    batchDeleteProjectSessionsConfirm: "batchDeleteProjectSessionsConfirm",
    approvalRequired: "approvalRequired",
    approvalUnavailable: "approvalUnavailable",
    authRequired: "authRequired",
    authLogin: "authLogin",
    activatingSession: "activatingSession",
    cancellingSession: "cancellingSession",
    retryActivation: "retryActivation",
    continueInNewConversation: "continueInNewConversation",
    goalLabel: "goalLabel",
    goalStatusActive: "goalStatusActive",
    goalStatusPaused: "goalStatusPaused",
    goalStatusBlocked: "goalStatusBlocked",
    goalStatusUsageLimited: "goalStatusUsageLimited",
    goalStatusBudgetLimited: "goalStatusBudgetLimited",
    goalStatusComplete: "goalStatusComplete",
    goalBudgetUsage: (used: number, budget: number) => `${used}/${budget}`,
    goalClearHint: "goalClearHint",
    processing: "processing",
    turnSummary: "turnSummary",
    planLead: "planLead",
    planModes: [],
    projectLocked: "projectLocked",
    projectMissingDescription: "projectMissingDescription",
    stayInPlan: "stayInPlan",
    sendFeedback: "sendFeedback",
    feedbackPlaceholder: "feedbackPlaceholder",
    previousQuestion: "previousQuestion",
    nextQuestion: "nextQuestion",
    submitAnswers: "submitAnswers",
    answerPlaceholder: "answerPlaceholder",
    waitingForAnswer: "waitingForAnswer",
    thinkingLabel: "thinkingLabel",
    toolCallsLabel: (count: number) => `toolCalls:${count}`,
    openConversationWindow: "openConversationWindow",
    showMoreConversations: "showMoreConversations",
    showLessConversations: "showLessConversations",
    deleteSession: "deleteSession",
    pinSession: "pinSession",
    unpinSession: "unpinSession",
    deleteSessionTitle: "deleteSessionTitle",
    deleteSessionBody: "deleteSessionBody",
    deleteSessionConfirm: "deleteSessionConfirm",
    cancel: "cancel",
    conversationRailResizeAria: "conversationRailResizeAria",
    relativeTimeJustNow: "relativeTimeJustNow",
    relativeTimeMinutes: (count: number) => `${count}m`,
    relativeTimeHours: (count: number) => `${count}h`,
    relativeTimeDays: (count: number) => `${count}d`,
    relativeTimeMonths: (count: number) => `${count}mo`,
    relativeTimeYears: (count: number) => `${count}y`,
    slashCommandPalette: "slashCommandPalette",
    skillPickerPalette: "skillPickerPalette",
    slashPaletteCommandsGroup: "slashPaletteCommandsGroup",
    slashPaletteCapabilitiesGroup: "slashPaletteCapabilitiesGroup",
    slashPaletteSkillsGroup: "slashPaletteSkillsGroup",
    slashPalettePluginsGroup: "slashPalettePluginsGroup",
    slashPaletteConnectorsGroup: "slashPaletteConnectorsGroup",
    slashPaletteMcpGroup: "slashPaletteMcpGroup",
    browserUseCapabilityLabel: "browserUseCapabilityLabel",
    browserUseCapabilityDescription: "browserUseCapabilityDescription",
    browserUseCapabilityDescriptionAutoConnect:
      "browserUseCapabilityDescriptionAutoConnect",
    browserUseCapabilityDescriptionIsolated:
      "browserUseCapabilityDescriptionIsolated",
    browserUseCapabilitySettingsLabel: "browserUseCapabilitySettingsLabel",
    browserUseCapabilitySettingsDescription:
      "browserUseCapabilitySettingsDescription",
    capabilityInlineSettingsLabel: "capabilityInlineSettingsLabel",
    computerUseCapabilityLabel: "computerUseCapabilityLabel",
    computerUseCapabilityDescription: "computerUseCapabilityDescription",
    computerUseCapabilitySetupRequiredDescription:
      "computerUseCapabilitySetupRequiredDescription",
    computerUseCapabilityAuthorizationRequiredDescription:
      "computerUseCapabilityAuthorizationRequiredDescription",
    computerUseCapabilityAuthorizationUnknownDescription:
      "computerUseCapabilityAuthorizationUnknownDescription",
    computerUseCapabilitySettingsLabel: "computerUseCapabilitySettingsLabel",
    computerUseCapabilitySettingsDescription:
      "computerUseCapabilitySettingsDescription",
    slashStatusTitle: "slashStatusTitle",
    slashStatusSession: "slashStatusSession",
    slashStatusBaseUrl: "slashStatusBaseUrl",
    slashStatusContext: "slashStatusContext",
    slashStatusLimits: "slashStatusLimits",
    slashStatusClose: "slashStatusClose",
    slashStatusContextValue: ({ percentLeft, usedTokens, totalTokens }) =>
      `${percentLeft}:${usedTokens}:${totalTokens}`,
    slashStatusContextUnavailable: "slashStatusContextUnavailable",
    slashStatusLimitsUnavailable: "slashStatusLimitsUnavailable",
    usageChipLabel: ({ percent }) => `usageChip:${percent}`,
    usageTooltipLabel: "usageTooltipLabel",
    usagePopoverTitle: "usagePopoverTitle",
    usageContextWindowLabel: "usageContextWindowLabel",
    usageTokensLabel: "usageTokensLabel",
    usageLimitsLabel: "usageLimitsLabel",
    usageCompactAction: "usageCompactAction",
    planImplementationLead: "planImplementationLead",
    planImplementationConfirm: "planImplementationConfirm",
    planImplementationFeedbackPlaceholder:
      "planImplementationFeedbackPlaceholder",
    planImplementationSend: "planImplementationSend",
    planImplementationSkip: "planImplementationSkip",
    fileMentionPalette: "fileMentionPalette",
    fileMentionLoading: "fileMentionLoading",
    fileMentionEmpty: "fileMentionEmpty",
    fileMentionError: "fileMentionError",
    fileMentionTabHint: "fileMentionTabHint",
    removeMention: "removeMention",
    addReference: "addReference",
    referenceWorkspaceFiles: "referenceWorkspaceFiles",
    syncPending: "syncPending",
    syncSynced: "syncSynced",
    syncFailed: "syncFailed"
  };
}
