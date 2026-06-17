import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAgentSessionDetailViewModel } from "../../shared/workspaceAgentSessionDetailViewModel";
import type { AgentGUINodeViewModel } from "./model/agentGuiNodeTypes";
import { AgentGUINodeView, type AgentGUIViewLabels } from "./AgentGUINodeView";

const conversationFlowMock = vi.hoisted(() => ({
  calls: [] as Array<{ conversation: unknown; labels: unknown }>
}));

const composerMock = vi.hoisted(() => ({
  calls: [] as Array<{
    composerFocusRequestSequence?: number | null;
    isSendingTurn?: boolean;
    showStopButton?: boolean;
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
    isSendingTurn?: boolean;
    showStopButton?: boolean;
  }) => {
    composerMock.calls.push({
      composerFocusRequestSequence: props.composerFocusRequestSequence,
      isSendingTurn: props.isSendingTurn,
      showStopButton: props.showStopButton
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

describe("AgentGUINodeView layout persistence", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
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

  it("persists a later width change from the rail resize handle", () => {
    const onConversationRailWidthChanged = vi.fn();

    renderAgentGUINodeView({ onConversationRailWidthChanged });
    const resizeHandle = screen.getByTestId(
      "agent-gui-conversation-rail-resize-handle"
    );
    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 0,
      pointerId: 1
    });
    fireEvent.pointerMove(resizeHandle, { clientX: 120, pointerId: 1 });

    expect(onConversationRailWidthChanged).toHaveBeenCalledTimes(1);
    expect(onConversationRailWidthChanged).toHaveBeenCalledWith(360);
  });

  it("keeps the rail resize affordance active while dragging", () => {
    renderAgentGUINodeView();

    const resizeHandle = screen.getByTestId(
      "agent-gui-conversation-rail-resize-handle"
    );
    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      clientX: 0,
      pointerId: 1
    });

    expect(resizeHandle).toHaveAttribute("data-resizing", "true");

    fireEvent.pointerUp(resizeHandle, { pointerId: 1 });

    expect(resizeHandle).not.toHaveAttribute("data-resizing");
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
      /\.room-issue-node__search-field\s*{[^}]*position:\s*relative[^}]*min-width:\s*0/s
    );
    expect(css).toMatch(
      /\.room-issue-node__search-input\s*{[^}]*width:\s*100%[^}]*padding-right:\s*36px/s
    );
    expect(css).toMatch(
      /\.room-issue-node__search-clear-button\s*{[^}]*position:\s*absolute[^}]*right:\s*4px[^}]*width:\s*24px/s
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
        projectSectionEdit: "Edit"
      }
    });

    fireEvent.click(screen.getByLabelText("Edit"));

    expect(actions.createConversation).toHaveBeenCalledWith({
      projectPath: "/workspace/app"
    });
    expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBe(1);
  });

  it("hides the project rail header when the project selector is disabled", () => {
    const { container } = renderAgentGUINodeView({
      showProjectSelector: false,
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
      container.querySelector(".agent-gui-node__project-rail-header")
    ).toBeNull();
    expect(screen.getByText("App")).toBeInTheDocument();
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

  it("shows ready detail status as a compact green pulse dot", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation: createConversationSummary("session-1"),
        activeConversationId: "session-1",
        conversations: [createConversationSummary("session-1")]
      }
    });

    expect(statusDotMock.calls).toContainEqual(
      expect.objectContaining({
        ariaLabel: "statusReady",
        pulse: true,
        size: "sm",
        title: "statusReady",
        tone: "green"
      })
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

    expect(screen.getByText("statusWorking")).toBeInTheDocument();
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

    expect(screen.getByText("statusWorking")).toBeInTheDocument();
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
});

describe("AgentGUINodeView usage chip", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  function renderWithUsage(usage: AgentGUINodeViewModel["usage"]) {
    const activeConversation = createConversationSummary("session-1");
    return renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [activeConversation],
        activeConversation,
        activeConversationId: activeConversation.id,
        conversationDetail: createConversationDetail(),
        usage
      }
    });
  }

  it("renders the usage chip with the context percent", () => {
    renderWithUsage({
      usedTokens: 50_000,
      totalTokens: 200_000,
      percentUsed: 25,
      quotas: []
    });

    const chip = screen.getByTestId("agent-gui-usage-chip");
    expect(chip).toHaveTextContent("usageChip:25");
    expect(chip).toHaveAttribute("data-usage-level", "normal");
    expect(chip).toHaveClass("text-[13px]");
    expect(chip).toHaveClass("font-normal");
    expect(chip).toHaveClass("cursor-default");
    expect(chip.tagName).toBe("SPAN");

    const source = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentGUINodeView.tsx"),
      "utf8"
    );
    expect(source).toContain(
      'className="max-w-[320px] cursor-default text-xs"'
    );
  });

  it("marks the chip with the warning level at 80 percent and above", () => {
    renderWithUsage({
      usedTokens: 170_000,
      totalTokens: 200_000,
      percentUsed: 85,
      quotas: []
    });

    expect(screen.getByTestId("agent-gui-usage-chip")).toHaveAttribute(
      "data-usage-level",
      "warning"
    );
  });

  it("marks the chip with the critical level at 95 percent and above", () => {
    renderWithUsage({
      usedTokens: 194_000,
      totalTokens: 200_000,
      percentUsed: 97,
      quotas: []
    });

    expect(screen.getByTestId("agent-gui-usage-chip")).toHaveAttribute(
      "data-usage-level",
      "critical"
    );
  });

  it("hides the chip when usage is null", () => {
    renderWithUsage(null);

    expect(screen.queryByTestId("agent-gui-usage-chip")).toBeNull();
  });

  it("hides the chip when percentUsed is null even with quotas", () => {
    renderWithUsage({
      usedTokens: null,
      totalTokens: null,
      percentUsed: null,
      quotas: [{ quotaType: "weekly", percentRemaining: 90 }]
    });

    expect(screen.queryByTestId("agent-gui-usage-chip")).toBeNull();
  });
});

describe("AgentGUINodeView compact action", () => {
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

  function compactViewModel({
    usage = usageWithWindow,
    compactSupported = null,
    status = "ready"
  }: {
    usage?: AgentGUINodeViewModel["usage"];
    compactSupported?: boolean | null;
    status?: AgentGUINodeViewModel["conversations"][number]["status"];
  } = {}): AgentGUINodeViewModel {
    const activeConversation = {
      ...createConversationSummary("session-1"),
      status
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
          effectiveStatus: status,
          turnPhase: status === "working" ? "working" : "idle"
        }
      },
      usage,
      compactSupported
    };
  }

  it("renders the compact button beside the usage chip when capability is unknown", () => {
    renderAgentGUINodeView({ viewModel: compactViewModel() });

    expect(screen.getByTestId("agent-gui-usage-chip")).toBeInTheDocument();
    const compactButton = screen.getByTestId("agent-gui-compact-button");
    expect(compactButton).toBeEnabled();
    expect(compactButton).toHaveClass("text-[13px]");
    expect(compactButton).toHaveClass("font-normal");
  });

  it("renders the compact button when the capability resolves true", () => {
    renderAgentGUINodeView({
      viewModel: compactViewModel({ compactSupported: true })
    });

    expect(screen.getByTestId("agent-gui-compact-button")).toBeInTheDocument();
  });

  it("does not render the compact button when the capability resolves false", () => {
    renderAgentGUINodeView({
      viewModel: compactViewModel({ compactSupported: false })
    });

    expect(screen.queryByTestId("agent-gui-compact-button")).toBeNull();
  });

  it("does not render the compact button when usage is null", () => {
    renderAgentGUINodeView({ viewModel: compactViewModel({ usage: null }) });

    expect(screen.queryByTestId("agent-gui-compact-button")).toBeNull();
  });

  it("submits compact on click and stays disabled until the session returns to ready", () => {
    const actions = createActions();
    const view = renderAgentGUINodeView({
      viewModel: compactViewModel(),
      actions
    });

    fireEvent.click(screen.getByTestId("agent-gui-compact-button"));

    expect(actions.submitCompact).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("agent-gui-compact-button")).toBeDisabled();

    view.rerender(
      buildAgentGUINodeViewElement({
        viewModel: compactViewModel({ status: "working" }),
        actions
      })
    );
    expect(screen.getByTestId("agent-gui-compact-button")).toBeDisabled();

    view.rerender(
      buildAgentGUINodeViewElement({
        viewModel: compactViewModel({ status: "ready" }),
        actions
      })
    );
    expect(screen.getByTestId("agent-gui-compact-button")).toBeEnabled();
  });

  it("enables compact retry when a pending compact submission fails the session", () => {
    const actions = createActions();
    const view = renderAgentGUINodeView({
      viewModel: compactViewModel(),
      actions
    });

    fireEvent.click(screen.getByTestId("agent-gui-compact-button"));
    expect(screen.getByTestId("agent-gui-compact-button")).toBeDisabled();

    view.rerender(
      buildAgentGUINodeViewElement({
        viewModel: compactViewModel({ status: "failed" }),
        actions
      })
    );

    expect(screen.getByTestId("agent-gui-compact-button")).toBeEnabled();
  });

  it("enables compact retry when compact submission is rejected", async () => {
    const rejectedSubmission = Promise.reject(new Error("submit rejected"));
    void rejectedSubmission.catch(() => undefined);
    const actions = {
      ...createActions(),
      submitCompact: vi.fn(() => rejectedSubmission)
    };
    renderAgentGUINodeView({
      viewModel: compactViewModel(),
      actions
    });

    fireEvent.click(screen.getByTestId("agent-gui-compact-button"));
    expect(screen.getByTestId("agent-gui-compact-button")).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByTestId("agent-gui-compact-button")).toBeEnabled();
    });
  });

  it("disables the compact button while the session is working", () => {
    renderAgentGUINodeView({
      viewModel: compactViewModel({ status: "working" })
    });

    expect(screen.getByTestId("agent-gui-compact-button")).toBeDisabled();
  });
});

describe("AgentGUINodeView usage alert banner", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  function alertViewModel({
    usageAlert,
    percentUsed = 85,
    compactSupported = null
  }: {
    usageAlert: AgentGUINodeViewModel["usageAlert"];
    percentUsed?: number;
    compactSupported?: boolean | null;
  }): AgentGUINodeViewModel {
    const activeConversation = createConversationSummary("session-1");
    return {
      ...createViewModel(),
      conversations: [activeConversation],
      activeConversation,
      activeConversationId: activeConversation.id,
      conversationDetail: createConversationDetail(),
      usage: {
        usedTokens: Math.round((percentUsed / 100) * 200_000),
        totalTokens: 200_000,
        percentUsed,
        quotas: []
      },
      usageAlert,
      compactSupported
    };
  }

  it("does not render the banner when there is no usage alert", () => {
    renderAgentGUINodeView({ viewModel: alertViewModel({ usageAlert: null }) });

    expect(screen.queryByTestId("agent-gui-usage-alert")).toBeNull();
  });

  it("keeps the usage alert attached to the composer with inset square bottom corners", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const usageAlertRule = css.match(
      /\.agent-gui-node__usage-alert-banner\s*{[^}]*}/s
    )?.[0];

    expect(usageAlertRule).toContain("margin: 0 24px;");
    expect(usageAlertRule).toContain("border-radius: 8px 8px 0 0;");
    expect(usageAlertRule).toContain("font-size: 13px;");
    expect(usageAlertRule).toContain("font-weight: 400;");
    expect(usageAlertRule).not.toContain("margin: 0 12px 8px;");

    const usageAlertDismissRule = css.match(
      /\.agent-gui-node__usage-alert-dismiss\s*{[^}]*}/s
    )?.[0];
    expect(usageAlertDismissRule).toContain("border-radius: 4px;");
  });

  it("renders the warn banner without a compact action", () => {
    renderAgentGUINodeView({
      viewModel: alertViewModel({ usageAlert: "warn", percentUsed: 85 })
    });

    const banner = screen.getByTestId("agent-gui-usage-alert");
    expect(banner).toHaveAttribute("data-usage-alert-tier", "warn");
    expect(banner).toHaveTextContent("usageAlertWarn:85");
    expect(screen.queryByTestId("agent-gui-usage-alert-compact")).toBeNull();
  });

  it("renders the critical banner with a compact action that submits and dismisses", () => {
    const actions = createActions();
    renderAgentGUINodeView({
      viewModel: alertViewModel({ usageAlert: "critical", percentUsed: 97 }),
      actions
    });

    const banner = screen.getByTestId("agent-gui-usage-alert");
    expect(banner).toHaveAttribute("data-usage-alert-tier", "critical");
    expect(banner).toHaveTextContent("usageAlertCritical:97");

    fireEvent.click(screen.getByTestId("agent-gui-usage-alert-compact"));

    expect(actions.submitCompact).toHaveBeenCalledTimes(1);
    expect(actions.dismissUsageAlert).toHaveBeenCalledTimes(1);
  });

  it("hides the compact action on the critical banner when compact is unsupported", () => {
    renderAgentGUINodeView({
      viewModel: alertViewModel({
        usageAlert: "critical",
        compactSupported: false
      })
    });

    expect(screen.getByTestId("agent-gui-usage-alert")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-gui-usage-alert-compact")).toBeNull();
  });

  it("dismisses the banner through the dismiss button", () => {
    const actions = createActions();
    renderAgentGUINodeView({
      viewModel: alertViewModel({ usageAlert: "warn" }),
      actions
    });

    fireEvent.click(screen.getByTestId("agent-gui-usage-alert-dismiss"));

    expect(actions.dismissUsageAlert).toHaveBeenCalledTimes(1);
    expect(actions.submitCompact).not.toHaveBeenCalled();
  });
});

interface RenderAgentGUINodeViewOptions {
  conversationRailCollapsed?: boolean;
  conversationRailWidthPx?: number;
  onConversationRailWidthChanged?: (widthPx: number) => void;
  viewModel?: AgentGUINodeViewModel;
  actions?: AgentGUINodeViewProps["actions"];
  labels?: AgentGUIViewLabels;
  showProjectSelector?: boolean;
}

function buildAgentGUINodeViewElement({
  conversationRailCollapsed = false,
  conversationRailWidthPx = 240,
  onConversationRailWidthChanged = vi.fn(),
  viewModel = createViewModel(),
  actions = createActions(),
  labels = createLabels(),
  showProjectSelector = true
}: RenderAgentGUINodeViewOptions = {}) {
  return (
    <AgentGUINodeView
      viewModel={viewModel}
      isAgentProviderReady={true}
      actions={actions}
      workspaceUserProjectI18n={workspaceUserProjectI18n}
      conversationRailCollapsed={conversationRailCollapsed}
      conversationRailWidthPx={conversationRailWidthPx}
      conversationRailMinWidthPx={220}
      conversationRailMaxWidthPx={420}
      detailMinWidthPx={220}
      uiLanguage="en"
      showProjectSelector={showProjectSelector}
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
    submitCompact: vi.fn(),
    dismissUsageAlert: vi.fn(),
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
    isCreatingConversation: false,
    isSubmitting: false,
    isInterrupting: false,
    isRespondingApproval: false,
    promptImagesSupported: true,
    compactSupported: null,
    usage: null,
    usageAlert: null,
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
      planUnavailable: false,
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
    collaboratorSessionReadOnlyPlaceholder:
      "collaboratorSessionReadOnlyPlaceholder",
    send: "send",
    modelLabel: "model",
    modelSelectionLabel: "modelSelectionLabel",
    defaultModel: "defaultModel",
    inheritedUnavailable: "inheritedUnavailable",
    reasoningLabel: "reasoning",
    reasoningDegreeLabel: "reasoningDegreeLabel",
    reasoningOptionMinimal: "reasoningOptionMinimal",
    reasoningOptionLow: "reasoningOptionLow",
    reasoningOptionMedium: "reasoningOptionMedium",
    reasoningOptionHigh: "reasoningOptionHigh",
    reasoningOptionXHigh: "reasoningOptionXHigh",
    speedLabel: "Speed",
    speedSelectionLabel: "Speed",
    speedOptionStandard: "Standard",
    speedOptionFast: "Fast",
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
    retryActivation: "retryActivation",
    continueInNewConversation: "continueInNewConversation",
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
    browserUseCapabilityLabel: "browserUseCapabilityLabel",
    browserUseCapabilityDescription: "browserUseCapabilityDescription",
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
    usagePopoverTitle: "usagePopoverTitle",
    usageTokensLabel: "usageTokensLabel",
    usageLimitsLabel: "usageLimitsLabel",
    usageCompactAction: "usageCompactAction",
    usageCompactTooltip: "usageCompactTooltip",
    usageAlertWarnMessage: ({ percent }) => `usageAlertWarn:${percent}`,
    usageAlertCriticalMessage: ({ percent }) => `usageAlertCritical:${percent}`,
    usageAlertDismiss: "usageAlertDismiss",
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
    syncFailed: "syncFailed",
    statusWorking: "statusWorking",
    statusWaiting: "statusWaiting",
    statusReady: "statusReady",
    statusCompleted: "statusCompleted",
    statusFailed: "statusFailed",
    statusCanceled: "statusCanceled"
  };
}
