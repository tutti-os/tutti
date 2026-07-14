import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeAgentActivitySession,
  type AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentSessionDetailViewModel } from "../../shared/workspaceAgentSessionDetailViewModel";
import type { AgentPromptContentBlock } from "../../shared/contracts/dto";
import type { AgentGUINodeViewModel } from "./model/agentGuiNodeTypes";
import {
  flattenAgentGUINodeViewModelFixture,
  groupAgentGUINodeViewModelFixture,
  type AgentGUINodeViewModelFixtureOverrides,
  type FlatAgentGUINodeViewModelFixture
} from "./model/AgentGUINodeViewModel.fixture";
import {
  AgentGUINodeView,
  updateConversationSectionsFromSummaries,
  type AgentGUIViewLabels
} from "./AgentGUINodeView";
import {
  createLocalAgentGUIAgentTarget,
  createLocalAgentGUIAgentTargets
} from "../../agentTargets";
import {
  agentGUIProviderRailOrderStorageKey,
  parseAgentGUIProviderRailPreferences
} from "./model/agentGuiProviderRailOrder";
import {
  AgentActivityRuntimeProvider,
  type AgentActivityRuntime,
  type AgentActivityRuntimeSessionSection,
  type AgentActivityRuntimeSessionSectionsResult
} from "../../agentActivityRuntime";
import { agentColorfulUrl } from "../../managedAgentIconAssets";
import { createTestAgentSessionEngine } from "../../shared/testing/createTestAgentSessionEngine";
import { MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS } from "../../shared/managedAgentIcons";

const conversationFlowMock = vi.hoisted(() => ({
  calls: [] as Array<{ conversation: unknown; labels: unknown }>
}));

const conversationMetaMock = vi.hoisted(() => ({
  calls: [] as string[]
}));

const composerMock = vi.hoisted(() => ({
  commits: 0,
  calls: [] as Array<{
    backgroundAgentStatusText?: string | null;
    composerFocusRequestSequence?: number | null;
    compactSupported?: boolean | null;
    isSendingTurn?: boolean;
    onSubmit?: (
      content: AgentPromptContentBlock[],
      displayPrompt?: string
    ) => void;
    provider?: string;
    showStopButton?: boolean;
    usage?: AgentGUINodeViewModel["detail"]["usage"];
  }>
}));

const verticalPaneRenderMock = vi.hoisted(() => ({
  railCommits: 0,
  timelineCommits: 0
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

const agentManagerToastMock = vi.hoisted(() => ({
  error: vi.fn()
}));

function ensurePointerCaptureApi(): void {
  const elementPrototype = Element.prototype as Element & {
    hasPointerCapture?: (pointerId: number) => boolean;
    releasePointerCapture?: (pointerId: number) => void;
    setPointerCapture?: (pointerId: number) => void;
  };
  if (!elementPrototype.hasPointerCapture) {
    Object.defineProperty(elementPrototype, "hasPointerCapture", {
      configurable: true,
      value: () => false
    });
  }
  if (!elementPrototype.releasePointerCapture) {
    Object.defineProperty(elementPrototype, "releasePointerCapture", {
      configurable: true,
      value: () => {}
    });
  }
  if (!elementPrototype.setPointerCapture) {
    Object.defineProperty(elementPrototype, "setPointerCapture", {
      configurable: true,
      value: () => {}
    });
  }
}

function createDataTransferStub(): DataTransfer {
  const store = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    get types() {
      return [...store.keys()];
    },
    clearData(format?: string) {
      if (format) {
        store.delete(format);
      } else {
        store.clear();
      }
    },
    getData(format: string) {
      return store.get(format) ?? "";
    },
    setData(format: string, data: string) {
      store.set(format, data);
    },
    setDragImage() {}
  };
}

vi.mock("./AgentSessionChrome", () => ({
  AgentSessionChrome: () => <div data-testid="agent-session-chrome" />
}));

vi.mock("./AgentComposer", async () => {
  const { memo, Profiler } =
    await vi.importActual<typeof import("react")>("react");
  return {
    AgentComposer: memo(
      (props: {
        backgroundAgentStatusText?: string | null;
        composerFocusRequestSequence?: number | null;
        compactSupported?: boolean | null;
        isSendingTurn?: boolean;
        onSubmit?: (
          content: AgentPromptContentBlock[],
          displayPrompt?: string
        ) => void;
        provider?: string;
        showStopButton?: boolean;
        usage?: AgentGUINodeViewModel["detail"]["usage"];
      }) => {
        composerMock.calls.push({
          backgroundAgentStatusText: props.backgroundAgentStatusText,
          composerFocusRequestSequence: props.composerFocusRequestSequence,
          compactSupported: props.compactSupported,
          isSendingTurn: props.isSendingTurn,
          provider: props.provider,
          onSubmit: props.onSubmit,
          showStopButton: props.showStopButton,
          usage: props.usage
        });
        return (
          <Profiler
            id="agent-composer-render-budget"
            onRender={() => composerMock.commits++}
          >
            <div data-testid="agent-composer" />
          </Profiler>
        );
      }
    ),
    formatSlashStatusTokenCount: (value: number | null | undefined) =>
      typeof value === "number" ? value.toLocaleString("en-US") : ""
  };
});

vi.mock("./view/AgentGUIConversationRailPane", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./view/AgentGUIConversationRailPane")
    >();
  const { createElement, memo, Profiler } =
    await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    AgentGUIConversationRailPane: memo(
      (props: Parameters<typeof actual.AgentGUIConversationRailPane>[0]) => (
        <Profiler
          id="agent-gui-rail-render-budget"
          onRender={() => verticalPaneRenderMock.railCommits++}
        >
          {createElement(actual.AgentGUIConversationRailPane, props)}
        </Profiler>
      )
    )
  };
});

vi.mock("./view/AgentGUIConversationTimelinePane", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./view/AgentGUIConversationTimelinePane")
    >();
  const { createElement, memo, Profiler } =
    await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    AgentGUIConversationTimelinePane: memo(
      (
        props: Parameters<typeof actual.AgentGUIConversationTimelinePane>[0]
      ) => (
        <Profiler
          id="agent-gui-timeline-render-budget"
          onRender={() => verticalPaneRenderMock.timelineCommits++}
        >
          {createElement(actual.AgentGUIConversationTimelinePane, props)}
        </Profiler>
      )
    )
  };
});

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

vi.mock("@tutti-os/ui-system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tutti-os/ui-system")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      error: agentManagerToastMock.error
    },
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
  };
});

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
    composerMock.commits = 0;
    composerMock.calls = [];
    verticalPaneRenderMock.railCommits = 0;
    verticalPaneRenderMock.timelineCommits = 0;
    statusDotMock.calls = [];
    agentManagerToastMock.error.mockReset();
    globalThis.localStorage.clear();
    vi.useRealTimers();
  });

  it("keeps composer and rail vertical boundaries idle for a detail update", () => {
    const initial = createActiveRenderBudgetViewModel();
    const stableOptions = {
      actions: createActions(),
      labels: createLabels()
    };
    const rendered = renderAgentGUINodeView({
      ...stableOptions,
      viewModel: initial
    });
    expect(composerMock.commits).toBeGreaterThan(0);
    expect(verticalPaneRenderMock.railCommits).toBeGreaterThan(0);
    composerMock.commits = 0;
    verticalPaneRenderMock.railCommits = 0;

    rendered.rerender(
      buildAgentGUINodeViewElement({
        ...stableOptions,
        viewModel: {
          ...initial,
          detail: {
            ...initial.detail,
            isLoadingMessages: true
          }
        }
      })
    );

    expect(composerMock.commits).toBe(0);
    expect(verticalPaneRenderMock.railCommits).toBe(0);
  });

  it("keeps composer and timeline vertical boundaries idle for a rail update", () => {
    const initial = createActiveRenderBudgetViewModel();
    const stableOptions = {
      actions: createActions(),
      labels: createLabels()
    };
    const rendered = renderAgentGUINodeView({
      ...stableOptions,
      viewModel: initial
    });
    expect(composerMock.commits).toBeGreaterThan(0);
    expect(verticalPaneRenderMock.timelineCommits).toBeGreaterThan(0);
    composerMock.commits = 0;
    verticalPaneRenderMock.timelineCommits = 0;

    rendered.rerender(
      buildAgentGUINodeViewElement({
        ...stableOptions,
        viewModel: {
          ...initial,
          rail: {
            ...initial.rail,
            isLoadingConversations: true
          }
        }
      })
    );

    expect(composerMock.commits).toBe(0);
    expect(verticalPaneRenderMock.timelineCommits).toBe(0);
  });

  it("keeps rail and timeline vertical boundaries idle while typing", () => {
    const initial = createActiveRenderBudgetViewModel();
    const stableOptions = {
      actions: createActions(),
      labels: createLabels()
    };
    const rendered = renderAgentGUINodeView({
      ...stableOptions,
      viewModel: initial
    });
    expect(verticalPaneRenderMock.railCommits).toBeGreaterThan(0);
    expect(verticalPaneRenderMock.timelineCommits).toBeGreaterThan(0);
    verticalPaneRenderMock.railCommits = 0;
    verticalPaneRenderMock.timelineCommits = 0;

    rendered.rerender(
      buildAgentGUINodeViewElement({
        ...stableOptions,
        viewModel: {
          ...initial,
          composer: {
            ...initial.composer,
            draftContent: { prompt: "x", images: [] },
            draftPrompt: "x"
          }
        }
      })
    );

    expect(verticalPaneRenderMock.railCommits).toBe(0);
    expect(verticalPaneRenderMock.timelineCommits).toBe(0);
  });

  it("does not persist the initial layout callback on mount", () => {
    const onConversationRailWidthChanged = vi.fn();

    renderAgentGUINodeView({ onConversationRailWidthChanged });

    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();
  });

  it("always renders the provider filter rail", () => {
    const agentTargets = [
      createLocalAgentGUIAgentTarget("codex"),
      createLocalAgentGUIAgentTarget("claude-code")
    ];
    const { container, rerender } = renderAgentGUINodeView({
      viewModel: createViewModel({ agentTargets })
    });

    const providerRailPanel = container.querySelector(
      ".agent-gui-node__provider-rail-panel"
    );
    expect(providerRailPanel).not.toBeNull();
    expect(providerRailPanel).toHaveClass("nodrag");
    expect(providerRailPanel).toHaveClass("tsh-desktop-no-drag");
    expect(providerRailPanel).toContainElement(
      container.querySelector('[role="tablist"]')
    );
    expect(
      container
        .querySelector(".agent-gui-node__rail")
        ?.querySelector('[role="tablist"]')
    ).toBeNull();

    const layout = container.querySelector<HTMLElement>(
      ".agent-gui-node__layout"
    );
    expect(
      layout?.style.getPropertyValue("--agent-gui-provider-rail-width")
    ).toBe("52px");

    rerender(
      buildAgentGUINodeViewElement({
        conversationRailCollapsed: true,
        viewModel: createViewModel({
          agentTargets
        })
      })
    );

    expect(
      container.querySelector(".agent-gui-node__provider-rail-panel")
    ).not.toBeNull();
    expect(
      container.querySelector(".agent-gui-node__provider-rail-panel")
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      layout?.style.getPropertyValue("--agent-gui-provider-rail-width")
    ).toBe("0px");
    expect(layout?.style.gridTemplateColumns).toBe(
      "var(--agent-gui-provider-rail-width) var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
    );
  });

  it("renders an injected provider rail footer with neutral context", () => {
    const activeConversation = createConversationSummary("session-1", {
      title: "Active conversation"
    });
    const renderSidebarFooter = vi.fn(
      ({
        currentUserId,
        activeConversation
      }: Parameters<
        NonNullable<AgentGUINodeViewProps["renderSidebarFooter"]>
      >[0]) => (
        <button type="button">
          Footer {currentUserId} {activeConversation?.id}
        </button>
      )
    );

    const { container } = renderAgentGUINodeView({
      renderSidebarFooter,
      viewModel: createViewModel({
        currentUserId: "user-1",
        activeConversation,
        activeConversationId: activeConversation.id,
        conversations: [activeConversation]
      })
    });

    const footer = screen.getByTestId("agent-gui-sidebar-footer-slot");
    const providerTileScrollArea = screen.getByRole("tablist", {
      name: "Switch provider"
    });
    expect(footer).toHaveTextContent("Footer user-1 session-1");
    expect(footer).toHaveClass("agent-gui-node__provider-rail-sidebar-footer");
    expect(
      container.querySelector(".agent-gui-node__provider-rail-panel")
    ).toContainElement(footer);
    expect(providerTileScrollArea).not.toContainElement(footer);
    expect(
      container.querySelector(".agent-gui-node__rail")
    ).not.toContainElement(footer);
    expect(renderSidebarFooter).toHaveBeenCalledWith({
      currentUserId: "user-1",
      activeConversation
    });
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

  it("renders the account menu and refreshes it on open", async () => {
    const onOpenChange = vi.fn();
    const onSettings = vi.fn();
    const openedUrls: string[] = [];

    renderAgentGUINodeView({
      accountMenuState: {
        user: {
          userId: "user-1",
          name: "Jane",
          email: "jane@example.com",
          avatar: null
        },
        membershipLabel: "Pro",
        creditsLabel: "2,450",
        loading: false,
        error: null,
        links: {
          planUrl: "https://tutti.sh/profile/plan",
          usageUrl: "https://tutti.sh/profile/usage",
          settingsUrl: "https://tutti.sh/profile/settings"
        },
        onOpenChange,
        onLogin: vi.fn(),
        onLogout: vi.fn(),
        onSettings,
        onOpenExternal(url) {
          openedUrls.push(url);
        }
      }
    });

    const trigger = screen.getByRole("button", { name: "Jane" });
    expect(trigger).toHaveTextContent("Jane");
    expect(trigger).toHaveTextContent("Pro");
    expect(trigger).not.toHaveTextContent("jane@example.com");
    expect(
      trigger.querySelector("[data-account-membership-badge='true']")
    ).not.toBeNull();
    fireEvent.click(trigger);

    expect(onOpenChange).toHaveBeenCalledWith(true);
    const menu = await screen.findByTestId("agent-gui-account-menu");
    expect(menu).toHaveTextContent("Jane");
    expect(menu).toHaveTextContent("Pro");
    expect(
      menu.querySelector("[data-account-membership-badge='true']")
    ).not.toBeNull();
    expect(menu).toHaveTextContent("Upgrade");
    expect(menu).toHaveTextContent("2,450");
    expect(menu).toHaveTextContent("Settings");

    fireEvent.click(within(menu).getByText("Member"));
    expect(openedUrls).toEqual(["https://tutti.sh/profile/plan"]);
    fireEvent.click(within(menu).getByText("Settings"));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("renders a dismissible registration credits toast above the account row", () => {
    const onDismiss = vi.fn();
    renderAgentGUINodeView({
      accountMenuState: {
        user: {
          userId: "user-1",
          name: "Jane",
          email: "jane@example.com",
          avatar: null
        },
        membershipLabel: "Free",
        creditsLabel: "500",
        loading: false,
        error: null,
        registrationCreditsToast: {
          id: "registrationCreditsToastShown:user-1:grant-1",
          creditsLabel: "500",
          visible: true,
          autoDismissMs: 120_000,
          onDismiss
        },
        links: {
          planUrl: "https://tutti.sh/profile/plan",
          usageUrl: "https://tutti.sh/profile/usage",
          settingsUrl: "https://tutti.sh/profile/settings"
        },
        onOpenChange: vi.fn(),
        onLogin: vi.fn(),
        onLogout: vi.fn(),
        onOpenExternal: vi.fn()
      }
    });

    const toast = screen.getByTestId("agent-gui-account-reward-toast");
    expect(toast).toHaveTextContent("New user credits");
    expect(toast).toHaveTextContent("+500 credits");
    expect(toast).toHaveTextContent("Added to account balance");
    expect(screen.queryByText("Account center")).toBeNull();

    fireEvent.click(
      within(toast).getByRole("button", {
        name: "Close credits reward notification"
      })
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("hides the account rail menu when no signed-in user is available", () => {
    const { container } = renderAgentGUINodeView({
      accountMenuState: {
        user: null,
        membershipLabel: "",
        creditsLabel: null,
        loading: false,
        error: null,
        links: {
          planUrl: "https://tutti.sh/profile/plan",
          usageUrl: "https://tutti.sh/profile/usage",
          settingsUrl: "https://tutti.sh/profile/settings"
        },
        onOpenChange: vi.fn(),
        onLogin: vi.fn(),
        onLogout: vi.fn(),
        onOpenExternal: vi.fn()
      }
    });

    expect(
      container.querySelector("[data-account-menu-trigger='true']")
    ).toBeNull();
    expect(screen.queryByText("Tutti Agent")).toBeNull();
    expect(screen.queryByText("Free")).toBeNull();
  });

  it("shows a localized account data warning for partial summary failures", async () => {
    renderAgentGUINodeView({
      accountMenuState: {
        user: {
          userId: "user-1",
          name: "Jane",
          email: "jane@example.com",
          avatar: null
        },
        membershipLabel: "",
        creditsLabel: null,
        loading: false,
        error: null,
        partialError: true,
        links: {
          planUrl: "https://tutti.sh/profile/plan",
          usageUrl: "https://tutti.sh/profile/usage",
          settingsUrl: "https://tutti.sh/profile/settings"
        },
        onOpenChange: vi.fn(),
        onLogin: vi.fn(),
        onLogout: vi.fn(),
        onOpenExternal: vi.fn()
      }
    });

    fireEvent.click(screen.getByRole("button", { name: "Jane" }));

    const menu = await screen.findByTestId("agent-gui-account-menu");
    expect(menu).toHaveTextContent("Some account data is unavailable");
  });

  it("sets the controlled rail width on the grid layout", () => {
    const onConversationRailWidthChanged = vi.fn();

    const { container } = renderAgentGUINodeView({
      conversationRailWidthPx: 320,
      onConversationRailWidthChanged
    });

    const layout = container.querySelector<HTMLElement>(
      ".agent-gui-node__layout"
    );
    expect(layout).toHaveStyle({
      "--agent-gui-conversation-rail-width": "320px"
    });
    expect(
      layout?.style.getPropertyValue(
        "--agent-gui-conversation-rail-content-width"
      )
    ).toBe("320px");
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

    const { container } = renderAgentGUINodeView({
      conversationRailCollapsed: true,
      onConversationRailWidthChanged
    });

    const layout = container.querySelector<HTMLElement>(
      ".agent-gui-node__layout"
    );
    const railPanel = container.querySelector(".agent-gui-node__rail-panel");
    const resizeHandle = screen.getByTestId(
      "agent-gui-conversation-rail-resize-handle"
    );
    expect(
      layout?.style.getPropertyValue("--agent-gui-conversation-rail-width")
    ).toBe("0px");
    expect(
      layout?.style.getPropertyValue(
        "--agent-gui-conversation-rail-content-width"
      )
    ).toBe("240px");
    expect(layout?.style.gridTemplateColumns).toBe(
      "var(--agent-gui-provider-rail-width) var(--agent-gui-conversation-rail-width) minmax(var(--agent-gui-detail-min-width), 1fr)"
    );
    expect(railPanel).not.toBeNull();
    expect(railPanel).toHaveAttribute("aria-hidden", "true");
    expect(railPanel).toHaveClass("agent-gui-node__rail-panel--collapsed");
    expect(resizeHandle).toHaveAttribute("aria-hidden", "true");
    expect(resizeHandle).toHaveClass("pointer-events-none");
    expect(resizeHandle).toHaveClass("opacity-0");
    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();
  });

  it("keeps the active conversation content visible when the rail is collapsed", () => {
    const conversation = createConversationSummary("session-1");

    renderAgentGUINodeView({
      conversationRailCollapsed: true,
      viewModel: {
        ...createViewModel(),
        activeConversation: conversation,
        activeConversationId: conversation.id,
        conversations: [conversation],
        conversationDetail: createConversationDetail()
      }
    });

    expect(screen.getByTestId("agent-conversation-flow")).toBeInTheDocument();
    expect(screen.getByTestId("agent-composer")).toBeInTheDocument();
  });

  it("switches the conversation filter from the avatar rail tile", () => {
    const actions = createActions();
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        agentTargets: [createLocalAgentGUIAgentTarget("codex"), claudeTarget]
      }
    });

    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));

    expect(actions.selectConversationFilterTarget).toHaveBeenCalledWith({
      provider: "claude-code",
      agentTargetId: claudeTarget.targetId
    });
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("requests composer focus after switching the provider rail target", async () => {
    const actions = createActions();
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        agentTargets: [createLocalAgentGUIAgentTarget("codex"), claudeTarget]
      }
    });

    expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));

    await waitFor(() => {
      expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBe(1);
    });
  });

  it("requests composer focus after switching the provider rail to All", async () => {
    const actions = createActions();
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: codexTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: codexTarget,
        agentTargets: [
          codexTarget,
          createLocalAgentGUIAgentTarget("claude-code")
        ]
      }
    });

    expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "All" }));

    expect(actions.updateConversationFilter).toHaveBeenCalledWith({
      kind: "all"
    });
    await waitFor(() => {
      expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBe(1);
    });
  });

  it("keeps unavailable provider rail targets visually disabled but selectable", () => {
    const actions = createActions();
    const tuttiTarget = {
      ...createLocalAgentGUIAgentTarget("nexight"),
      disabled: true
    };
    const hermesTarget = {
      ...createLocalAgentGUIAgentTarget("hermes"),
      disabled: true
    };
    const openclawTarget = {
      ...createLocalAgentGUIAgentTarget("openclaw"),
      disabled: true
    };
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        agentTargets: [
          createLocalAgentGUIAgentTarget("codex"),
          createLocalAgentGUIAgentTarget("claude-code"),
          tuttiTarget,
          hermesTarget,
          openclawTarget
        ]
      }
    });

    const tuttiTile = screen.getByRole("tab", { name: "Nexight" });
    const hermesTile = screen.getByRole("tab", { name: "Hermes Agent" });
    const openclawTile = screen.getByRole("tab", { name: "OpenClaw" });

    expect(tuttiTile).toHaveAttribute("data-disabled", "true");
    expect(hermesTile).toHaveAttribute("data-disabled", "true");
    expect(openclawTile).toHaveAttribute("data-disabled", "true");
    expect(tuttiTile).not.toBeDisabled();
    expect(hermesTile).not.toBeDisabled();
    expect(openclawTile).not.toBeDisabled();

    fireEvent.click(tuttiTile);
    fireEvent.click(hermesTile);
    fireEvent.click(openclawTile);

    expect(actions.selectConversationFilterTarget).toHaveBeenCalledTimes(3);
    expect(actions.selectConversationFilterTarget).toHaveBeenNthCalledWith(1, {
      provider: "nexight",
      agentTargetId: tuttiTarget.targetId
    });
    expect(actions.selectConversationFilterTarget).toHaveBeenNthCalledWith(2, {
      provider: "hermes",
      agentTargetId: hermesTarget.targetId
    });
    expect(actions.selectConversationFilterTarget).toHaveBeenNthCalledWith(3, {
      provider: "openclaw",
      agentTargetId: openclawTarget.targetId
    });
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("keeps every canonical provider descriptor visible", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [
          createLocalAgentGUIAgentTarget("tutti-agent"),
          {
            ...createLocalAgentGUIAgentTarget("nexight"),
            disabled: true
          }
        ]
      }
    });

    expect(screen.getAllByRole("tab", { name: "Tutti Agent" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Nexight" })).toHaveAttribute(
      "data-disabled",
      "true"
    );
  });

  it("orders all canonical provider rail tiles without visible provider labels", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [
          {
            ...createLocalAgentGUIAgentTarget("nexight"),
            disabled: true
          },
          createLocalAgentGUIAgentTarget("claude-code"),
          {
            ...createLocalAgentGUIAgentTarget("hermes"),
            disabled: true
          },
          createLocalAgentGUIAgentTarget("codex")
        ]
      }
    });

    expect(
      screen
        .getAllByRole("tab")
        .map(
          (tab) =>
            tab.getAttribute("aria-label") ??
            tab.textContent?.replace(/\s+/gu, " ").trim()
        )
    ).toEqual([
      "All",
      "Codex",
      "Claude Code",
      "Cursor",
      "Tutti Agent",
      "OpenCode",
      "Nexight",
      "Hermes Agent",
      "OpenClaw"
    ]);
    expect(screen.getByRole("tab", { name: "All" })).toHaveTextContent("All");
    expect(screen.getByRole("tab", { name: "Codex" })).toHaveTextContent("");
    expect(screen.getByRole("tab", { name: "Claude Code" })).toHaveTextContent(
      ""
    );
    expect(screen.getByRole("tab", { name: "Tutti Agent" })).toHaveTextContent(
      ""
    );
    expect(screen.getByRole("tab", { name: "Hermes Agent" })).toHaveTextContent(
      ""
    );
    expect(screen.getByRole("tab", { name: "OpenClaw" })).toHaveTextContent("");

    expect(
      screen
        .getByRole("tab", { name: "Claude Code" })
        .querySelector("img")
        ?.getAttribute("src")
    ).toBe(MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS["claude-code"]);
    expect(
      screen
        .getByRole("tab", { name: "Cursor" })
        .querySelector("img")
        ?.getAttribute("src")
    ).toBe(MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.cursor);
    expect(
      screen
        .getByRole("tab", { name: "Nexight" })
        .querySelector("img")
        ?.getAttribute("src")
    ).toBe(MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.tutti);
  });

  it("persists provider rail tile order after drag sorting", async () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    const cursorTarget = createLocalAgentGUIAgentTarget("cursor");
    const dataTransfer = createDataTransferStub();

    const { rerender } = renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [codexTarget, claudeTarget, cursorTarget]
      }
    });

    const providerTileLabels = () =>
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"));

    expect(providerTileLabels()).toEqual([
      "All",
      "Codex",
      "Claude Code",
      "Cursor",
      "Tutti Agent",
      "OpenCode",
      "Nexight",
      "Hermes Agent",
      "OpenClaw"
    ]);

    const codexTile = screen.getByRole("tab", { name: "Codex" });
    const cursorTile = screen.getByRole("tab", { name: "Cursor" });
    const providerRail = screen.getByRole("tablist");
    vi.spyOn(codexTile, "getBoundingClientRect").mockReturnValue({
      bottom: 52,
      height: 52,
      left: 0,
      right: 52,
      top: 0,
      width: 52,
      x: 0,
      y: 0,
      toJSON: () => ({})
    });

    fireEvent.dragStart(cursorTile, { dataTransfer });
    fireEvent.dragOver(codexTile, {
      clientY: 8,
      dataTransfer
    });
    fireEvent.dragOver(codexTile, {
      clientY: 30,
      dataTransfer
    });
    fireEvent.dragOver(cursorTile, { dataTransfer });
    fireEvent.dragOver(providerRail, { dataTransfer });
    fireEvent.drop(providerRail, {
      clientY: 372,
      dataTransfer
    });

    expect(providerTileLabels()).toEqual([
      "All",
      "Cursor",
      "Codex",
      "Claude Code",
      "Tutti Agent",
      "OpenCode",
      "Nexight",
      "Hermes Agent",
      "OpenClaw"
    ]);
    expect(
      parseAgentGUIProviderRailPreferences(
        globalThis.localStorage.getItem(agentGUIProviderRailOrderStorageKey())
      ).order
    ).toEqual([
      "local:cursor",
      "local:codex",
      "local:claude-code",
      "local:tutti-agent",
      "local:opencode",
      "local:nexight",
      "local:hermes",
      "local:openclaw"
    ]);

    rerender(
      buildAgentGUINodeViewElement({
        viewModel: {
          ...createViewModel(),
          agentTargets: [codexTarget, claudeTarget, cursorTarget]
        }
      })
    );

    await waitFor(() => {
      expect(providerTileLabels()).toEqual([
        "All",
        "Cursor",
        "Codex",
        "Claude Code",
        "Tutti Agent",
        "OpenCode",
        "Nexight",
        "Hermes Agent",
        "OpenClaw"
      ]);
    });
  });

  it("moves agents between the available and disabled grids", async () => {
    const actions = createActions();
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: codexTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: codexTarget,
        agentTargets: [codexTarget, claudeTarget]
      }
    });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));

    expect(
      screen.getByRole("dialog", { name: "manageAgentsTitle" })
    ).toBeInTheDocument();
    const availableGrid = screen.getByRole("list", {
      name: "manageAgentsAvailable"
    });
    expect(availableGrid).toHaveClass("grid-cols-5");
    expect(within(availableGrid).getByText("Codex")).toBeInTheDocument();
    expect(within(availableGrid).getByText("Claude Code")).toBeInTheDocument();
    expect(
      within(availableGrid)
        .getAllByTestId("agent-gui-provider-manager-tile")[0]
        ?.querySelector("img")
    ).toHaveClass("size-9");
    expect(
      screen.queryByRole("button", { name: "removeAgentFromSidebar:Codex" })
    ).toBeNull();
    expect(screen.getByText("manageAgentsNoDisabled")).toBeInTheDocument();

    const codexManagerTile = within(availableGrid).getAllByTestId(
      "agent-gui-provider-manager-tile"
    )[0]!;
    fireEvent.pointerDown(codexManagerTile, {
      button: 0,
      clientX: 20,
      clientY: 20,
      pointerId: 1
    });
    fireEvent.animationEnd(codexManagerTile, {
      animationName: "agent-gui-provider-manager-long-press"
    });
    expect(availableGrid).toHaveAttribute("data-editing", "true");
    fireEvent.click(availableGrid);
    expect(availableGrid).toHaveAttribute("data-editing", "false");
    fireEvent.keyDown(codexManagerTile, { key: "Enter" });
    fireEvent.click(
      screen.getByRole("button", { name: "removeAgentFromSidebar:Codex" })
    );

    expect(
      document.querySelector("[role='tab'][aria-label='Codex']")
    ).toBeNull();
    const disabledGrid = screen.getByRole("list", {
      name: "manageAgentsDisabled"
    });
    expect(disabledGrid).toHaveClass("grid-cols-5");
    expect(within(disabledGrid).getByText("Codex")).toBeInTheDocument();
    expect(
      within(disabledGrid)
        .getByTestId("agent-gui-provider-manager-disabled-tile")
        .querySelector("img")
    ).toHaveClass("size-9");
    expect(actions.updateConversationFilter).toHaveBeenCalledWith({
      kind: "all"
    });
    expect(
      parseAgentGUIProviderRailPreferences(
        globalThis.localStorage.getItem(agentGUIProviderRailOrderStorageKey())
      )
    ).toMatchObject({
      hiddenTargetIds: ["local:codex"]
    });

    expect(
      screen.getByRole("button", { name: "addAgentToSidebar:Codex" })
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("button", { name: "addAgentToSidebar:Codex" })
    ).toBeNull();
    fireEvent.keyDown(
      within(availableGrid).getAllByTestId(
        "agent-gui-provider-manager-tile"
      )[0]!,
      { key: "Enter" }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "addAgentToSidebar:Codex" })
    );
    expect(within(availableGrid).getByText("Codex")).toBeInTheDocument();
    expect(
      document.querySelector("[role='tab'][aria-label='Codex']")
    ).not.toBeNull();
    expect(screen.getByText("manageAgentsNoDisabled")).toBeInTheDocument();
    expect(
      parseAgentGUIProviderRailPreferences(
        globalThis.localStorage.getItem(agentGUIProviderRailOrderStorageKey())
      ).order.at(-1)
    ).toBe("local:codex");
  });

  it("keeps the manager close button outside the window drag region", async () => {
    renderAgentGUINodeView();

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));

    const dialog = screen.getByRole("dialog", { name: "manageAgentsTitle" });
    expect(dialog).toHaveClass(
      "nodrag",
      "tsh-desktop-no-drag",
      "[-webkit-app-region:no-drag]"
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "manageAgentsTitle" })
      ).toBeNull();
    });
  });

  it("uses the first Escape to leave edit mode and the second to close", async () => {
    renderAgentGUINodeView();

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));

    const availableGrid = screen.getByRole("list", {
      name: "manageAgentsAvailable"
    });
    fireEvent.keyDown(
      within(availableGrid).getAllByTestId(
        "agent-gui-provider-manager-tile"
      )[0]!,
      { key: "Enter" }
    );
    expect(availableGrid).toHaveAttribute("data-editing", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(availableGrid).toHaveAttribute("data-editing", "false");
    expect(
      screen.getByRole("dialog", { name: "manageAgentsTitle" })
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "manageAgentsTitle" })
      ).toBeNull();
    });
  });

  it("reorders only available agents in the management grid", () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [codexTarget, claudeTarget]
      }
    });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));
    const availableGrid = screen.getByRole("list", {
      name: "manageAgentsAvailable"
    });
    const tiles = within(availableGrid).getAllByTestId(
      "agent-gui-provider-manager-tile"
    );
    fireEvent.keyDown(tiles[0]!, { key: "Enter" });
    expect(availableGrid).toHaveAttribute("data-editing", "true");
    const dataTransfer = createDataTransferStub();
    vi.spyOn(tiles[1]!, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 80,
      left: 100,
      right: 180,
      top: 20,
      width: 80,
      x: 100,
      y: 20,
      toJSON: () => ({})
    });

    fireEvent.dragStart(tiles[0]!, { dataTransfer });
    fireEvent.dragOver(tiles[1]!, { clientX: 170, dataTransfer });
    expect(tiles[0]).toHaveAttribute("data-dragging", "true");
    expect(tiles[0]).toHaveAttribute("data-drag-active", "true");
    expect(tiles[1]).toHaveAttribute("data-drag-active", "true");
    expect(tiles[1]).toHaveAttribute("data-drag-over", "after");
    expect(
      within(tiles[1]!).getByTestId("agent-gui-provider-manager-drop-indicator")
    ).toHaveAttribute("data-position", "after");
    fireEvent.drop(tiles[1]!, { clientX: 170, dataTransfer });

    const reorderedTiles = within(availableGrid).getAllByTestId(
      "agent-gui-provider-manager-tile"
    );
    expect(
      reorderedTiles
        .map((tile) => tile.getAttribute("data-agent-target-id"))
        .slice(0, 2)
    ).toEqual(["local:claude-code", "local:codex"]);
    expect(reorderedTiles[0]).not.toHaveAttribute("data-drag-over");
    expect(reorderedTiles[1]).not.toHaveAttribute("data-dragging");
    expect(reorderedTiles[0]).not.toHaveAttribute("data-drag-active");
    expect(reorderedTiles[1]).not.toHaveAttribute("data-drag-active");
    expect(
      screen.queryByTestId("agent-gui-provider-manager-drop-indicator")
    ).toBeNull();
    expect(availableGrid).toHaveAttribute("data-editing", "true");
  });

  it("moves agents across the available and disabled drop zones", () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [codexTarget, claudeTarget],
        providerRailMode: "exact"
      }
    });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));
    fireEvent.keyDown(
      screen.getAllByTestId("agent-gui-provider-manager-tile")[0]!,
      { key: "Enter" }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "removeAgentFromSidebar:Codex" })
    );
    expect(
      screen.getByRole("list", { name: "manageAgentsAvailable" })
    ).toHaveAttribute("data-editing", "true");

    const disabledCodex = screen.getByTestId(
      "agent-gui-provider-manager-disabled-tile"
    );
    const availableClaude = screen.getByTestId(
      "agent-gui-provider-manager-tile"
    );
    vi.spyOn(availableClaude, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 80,
      left: 100,
      right: 180,
      top: 20,
      width: 80,
      x: 100,
      y: 20,
      toJSON: () => ({})
    });
    const restoreTransfer = createDataTransferStub();
    const dragOverAvailableClaude = (clientX: number) => {
      const event = createEvent.dragOver(availableClaude, {
        dataTransfer: restoreTransfer
      });
      Object.defineProperty(event, "clientX", { value: clientX });
      fireEvent(availableClaude, event);
    };
    fireEvent.dragStart(disabledCodex, { dataTransfer: restoreTransfer });
    dragOverAvailableClaude(130);
    expect(availableClaude).toHaveAttribute("data-drag-over", "before");
    dragOverAvailableClaude(143);
    expect(availableClaude).toHaveAttribute("data-drag-over", "before");
    dragOverAvailableClaude(150);
    expect(availableClaude).toHaveAttribute("data-drag-over", "after");
    dragOverAvailableClaude(130);
    fireEvent.drop(availableClaude, {
      clientX: 130,
      dataTransfer: restoreTransfer
    });

    expect(
      screen
        .getAllByTestId("agent-gui-provider-manager-tile")
        .map((tile) => tile.getAttribute("data-agent-target-id"))
    ).toEqual(["local:codex", "local:claude-code"]);
    expect(screen.getByText("manageAgentsNoDisabled")).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "manageAgentsAvailable" })
    ).toHaveAttribute("data-editing", "true");

    const disableTransfer = createDataTransferStub();
    const availableTiles = screen.getAllByTestId(
      "agent-gui-provider-manager-tile"
    );
    const disabledDropZone = screen.getByTestId(
      "agent-gui-provider-manager-disabled-drop-zone"
    );
    fireEvent.dragStart(availableTiles[1]!, { dataTransfer: disableTransfer });
    fireEvent.dragOver(disabledDropZone, { dataTransfer: disableTransfer });
    fireEvent.drop(disabledDropZone, { dataTransfer: disableTransfer });

    expect(
      screen
        .getAllByTestId("agent-gui-provider-manager-tile")
        .map((tile) => tile.getAttribute("data-agent-target-id"))
    ).toEqual(["local:codex"]);
    expect(
      screen
        .getByTestId("agent-gui-provider-manager-disabled-tile")
        .getAttribute("data-agent-target-id")
    ).toBe("local:claude-code");
  });

  it("blocks disabling a running Agent by action or cross-grid drag", () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    const workingConversation = createConversationSummary("session-working", {
      agentTargetId: codexTarget.targetId,
      provider: "codex",
      status: "working"
    });
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation: workingConversation,
        activeConversationId: workingConversation.id,
        agentTargets: [codexTarget, claudeTarget],
        conversations: [workingConversation],
        providerRailMode: "exact"
      }
    });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));
    const codexTile = screen
      .getAllByTestId("agent-gui-provider-manager-tile")
      .find(
        (tile) =>
          tile.getAttribute("data-agent-target-id") === codexTarget.targetId
      )!;
    fireEvent.keyDown(codexTile, { key: "Enter" });
    expect(codexTile).toHaveAttribute("data-running", "true");

    const removeButton = screen.getByRole("button", {
      name: "removeAgentFromSidebar:Codex"
    });
    expect(removeButton).not.toBeDisabled();
    expect(removeButton).toHaveAttribute(
      "title",
      "manageAgentsRunningBlocked:Codex"
    );
    fireEvent.click(removeButton);

    expect(agentManagerToastMock.error).toHaveBeenCalledWith(
      "manageAgentsRunningBlocked:Codex",
      { id: "agent-gui-provider-manager-running:local:codex" }
    );
    expect(
      parseAgentGUIProviderRailPreferences(
        globalThis.localStorage.getItem(agentGUIProviderRailOrderStorageKey())
      ).hiddenTargetIds
    ).toEqual([]);

    const dataTransfer = createDataTransferStub();
    const disabledDropZone = screen.getByTestId(
      "agent-gui-provider-manager-disabled-drop-zone"
    );
    fireEvent.dragStart(codexTile, { dataTransfer });
    fireEvent.dragOver(disabledDropZone, { dataTransfer });
    expect(disabledDropZone).toHaveAttribute("data-drop-blocked", "true");
    expect(agentManagerToastMock.error).toHaveBeenCalledTimes(2);
    fireEvent.drop(disabledDropZone, { dataTransfer });

    expect(agentManagerToastMock.error).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getAllByTestId("agent-gui-provider-manager-tile")
        .some(
          (tile) =>
            tile.getAttribute("data-agent-target-id") === codexTarget.targetId
        )
    ).toBe(true);
    expect(
      parseAgentGUIProviderRailPreferences(
        globalThis.localStorage.getItem(agentGUIProviderRailOrderStorageKey())
      ).hiddenTargetIds
    ).toEqual([]);
  });

  it("keeps the final exact-mode agent available", () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    renderAgentGUINodeView({
      renderProviderRailEmpty: () => <span>providerRailEmpty</span>,
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: codexTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: codexTarget,
        agentTargets: [codexTarget],
        providerRailMode: "exact"
      }
    });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));
    fireEvent.keyDown(screen.getByTestId("agent-gui-provider-manager-tile"), {
      key: "Enter"
    });
    const removeButton = screen.getByRole("button", {
      name: "removeAgentFromSidebar:Codex"
    });
    expect(removeButton).toBeDisabled();
    expect(removeButton).toHaveAttribute(
      "title",
      "manageAgentsKeepOneAvailable"
    );
    fireEvent.click(removeButton);

    const dataTransfer = createDataTransferStub();
    const availableTile = screen.getByTestId("agent-gui-provider-manager-tile");
    const disabledDropZone = screen.getByTestId(
      "agent-gui-provider-manager-disabled-drop-zone"
    );
    fireEvent.dragStart(availableTile, { dataTransfer });
    fireEvent.dragOver(disabledDropZone, { dataTransfer });
    fireEvent.drop(disabledDropZone, { dataTransfer });

    expect(
      screen.getByTestId("agent-gui-provider-manager-tile")
    ).toBeInTheDocument();
    expect(screen.queryByText("providerRailEmpty")).toBeNull();
    expect(screen.getByText("manageAgentsNoDisabled")).toBeInTheDocument();
  });

  it("uses Cursor colorful artwork for the provider rail even when the target has a session icon", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [
          {
            ...createLocalAgentGUIAgentTarget("cursor"),
            iconUrl: "app://old-cursor-target-icon.png"
          }
        ]
      }
    });

    expect(
      screen
        .getByRole("tab", { name: "Cursor" })
        .querySelector("img")
        ?.getAttribute("src")
    ).toBe(MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.cursor);
  });

  it("uses the configured All provider rail icon when provided", () => {
    renderAgentGUINodeView({
      providerRailAllPresentation: {
        iconUrl: "app://workspace-agent/all.png"
      }
    });

    expect(
      screen
        .getByRole("tab", { name: "All" })
        .querySelector("img")
        ?.getAttribute("src")
    ).toBe("app://workspace-agent/all.png");
  });

  it("shows provider names in tooltips for unlabeled provider rail icons", async () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [
          createLocalAgentGUIAgentTarget("codex"),
          createLocalAgentGUIAgentTarget("claude-code")
        ]
      }
    });

    const codexTile = screen.getByRole("tab", { name: "Codex" });
    expect(codexTile).toHaveTextContent("");

    fireEvent.pointerEnter(codexTile);
    fireEvent.mouseOver(codexTile);
    fireEvent.focus(codexTile);

    expect(await screen.findAllByText("Codex")).not.toHaveLength(0);
  });

  it("switches Codex into an agent-target conversation filter", () => {
    const actions = createActions();
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: claudeTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: claudeTarget,
        agentTargets: [codexTarget, claudeTarget]
      }
    });

    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));

    expect(actions.selectConversationFilterTarget).toHaveBeenCalledWith({
      provider: "codex",
      agentTargetId: codexTarget.targetId
    });
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("highlights All from the conversation filter without constraining target", () => {
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        selectedAgentTarget: claudeTarget,
        agentTargets: [createLocalAgentGUIAgentTarget("codex"), claudeTarget]
      }
    });

    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Claude Code" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("highlights Codex instead of All for an agent-target filter", () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: codexTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: codexTarget,
        agentTargets: [
          codexTarget,
          createLocalAgentGUIAgentTarget("claude-code")
        ]
      }
    });

    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByRole("tab", { name: "Codex" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("selects only the All tile for all-conversation mode", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        selectedAgentTarget: createLocalAgentGUIAgentTarget("codex"),
        agentTargets: [
          createLocalAgentGUIAgentTarget("codex"),
          createLocalAgentGUIAgentTarget("claude-code")
        ]
      }
    });

    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Codex" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("renders the All tile with the unified Agent icon", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        agentTargets: [
          createLocalAgentGUIAgentTarget("claude-code"),
          createLocalAgentGUIAgentTarget("codex")
        ]
      }
    });

    const allTile = screen.getByRole("tab", { name: "All" });
    const allIcon = allTile.querySelector(
      ".agent-gui-node__provider-rail-avatar-image"
    );
    expect(allIcon).not.toBeNull();
    expect(allIcon).toHaveAttribute("src", agentColorfulUrl);
  });

  it("keeps the selected All tile as the unified Agent icon", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        agentTargets: [
          createLocalAgentGUIAgentTarget("claude-code"),
          createLocalAgentGUIAgentTarget("codex")
        ]
      }
    });

    const allTile = screen.getByRole("tab", { name: "All" });
    const allIcon = allTile.querySelector(
      ".agent-gui-node__provider-rail-avatar-image"
    );
    expect(allIcon).not.toBeNull();
    expect(allIcon).not.toHaveAttribute("data-scrollable");
    expect(allIcon).toHaveAttribute("src", agentColorfulUrl);
  });

  it("renders the empty hero icon area with the vinyl carousel", () => {
    const codexTarget = {
      ...createLocalAgentGUIAgentTarget("codex"),
      badge: {
        iconUrl: "app://owner-avatar.png",
        label: "Owner avatar"
      }
    };
    const { container } = renderAgentGUINodeView({
      viewModel: createViewModel({
        conversationFilter: { kind: "all" },
        selectedAgentTarget: codexTarget,
        agentTargets: [
          createLocalAgentGUIAgentTarget("claude-code"),
          codexTarget
        ]
      })
    });

    const carousel = container.querySelector(
      ".agent-gui-node__empty-hero-carousel"
    );
    expect(carousel).not.toBeNull();
    expect(
      carousel?.querySelector(
        "canvas.agent-gui-node__empty-hero-carousel-canvas"
      )
    ).not.toBeNull();
    expect(carousel?.querySelector(".agent-gui-vinyl-player")).not.toBeNull();
    const items = Array.from(
      carousel?.querySelectorAll(".agent-gui-node__empty-hero-carousel-item") ??
        []
    );
    expect(items).toHaveLength(2);
    expect(
      items.filter(
        (item) => item.getAttribute("data-provider-active") === "true"
      )
    ).toHaveLength(1);
    const activeItem = items.find(
      (item) => item.getAttribute("data-provider-active") === "true"
    );
    expect(activeItem?.getAttribute("data-provider")).toBe("codex");
    expect(activeItem).toHaveAccessibleName(/Codex, Owner avatar/u);
  });

  it("keeps the vinyl carousel mounted and centers the selected target", () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    const { container, rerender } = renderAgentGUINodeView({
      viewModel: createViewModel({
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: codexTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: codexTarget,
        agentTargets: [codexTarget, claudeTarget]
      })
    });

    const initialCarousel = container.querySelector(
      ".agent-gui-node__empty-hero-carousel"
    );
    const initialItems = Array.from(
      initialCarousel?.querySelectorAll(
        ".agent-gui-node__empty-hero-carousel-item"
      ) ?? []
    );
    expect(initialCarousel).not.toBeNull();
    expect(
      initialItems
        .find((item) => item.getAttribute("data-provider-active") === "true")
        ?.getAttribute("data-provider")
    ).toBe("codex");

    rerender(
      buildAgentGUINodeViewElement({
        viewModel: createViewModel({
          conversationFilter: {
            kind: "agentTarget",
            agentTargetId: claudeTarget.agentTargetId ?? ""
          },
          selectedAgentTarget: claudeTarget,
          agentTargets: [codexTarget, claudeTarget]
        })
      })
    );

    const nextCarousel = container.querySelector(
      ".agent-gui-node__empty-hero-carousel"
    );
    const nextItems = Array.from(
      nextCarousel?.querySelectorAll(
        ".agent-gui-node__empty-hero-carousel-item"
      ) ?? []
    );
    expect(nextCarousel).toBe(initialCarousel);
    expect(nextItems).toEqual(initialItems);
    expect(
      nextItems
        .find((item) => item.getAttribute("data-provider-active") === "true")
        ?.getAttribute("data-provider")
    ).toBe("claude-code");
  });

  it("preserves the vinyl carousel canvas across readiness changes", () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    const agentTargets = [codexTarget, claudeTarget];
    const { container, rerender } = renderAgentGUINodeView({
      viewModel: createViewModel({
        selectedAgentTarget: codexTarget,
        agentTargets
      })
    });
    const initialCarousel = container.querySelector(
      ".agent-gui-node__empty-hero-carousel"
    );
    const initialCanvas = initialCarousel?.querySelector("canvas");
    expect(initialCarousel).not.toBeNull();
    expect(initialCanvas).not.toBeNull();

    rerender(
      buildAgentGUINodeViewElement({
        viewModel: createViewModel({
          providerReadinessGate: { status: "not_installed" },
          selectedAgentTarget: claudeTarget,
          agentTargets
        })
      })
    );

    const nextCarousel = container.querySelector(
      ".agent-gui-node__empty-hero-carousel"
    );
    expect(nextCarousel).toBe(initialCarousel);
    expect(nextCarousel?.querySelector("canvas")).toBe(initialCanvas);
    expect(
      nextCarousel?.querySelector(
        '[data-provider="claude-code"][data-provider-active="true"]'
      )
    ).not.toBeNull();
    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toBeInTheDocument();
  });

  it("keeps unavailable Agent options visible and selectable in the empty hero provider select", async () => {
    const actions = createActions();
    const disabledTuttiTarget = {
      ...createLocalAgentGUIAgentTarget("nexight"),
      disabled: true
    };
    const disabledHermesTarget = {
      ...createLocalAgentGUIAgentTarget("hermes"),
      disabled: true
    };
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        selectedAgentTarget: createLocalAgentGUIAgentTarget("codex"),
        agentTargets: [
          createLocalAgentGUIAgentTarget("codex"),
          createLocalAgentGUIAgentTarget("claude-code"),
          disabledTuttiTarget,
          disabledHermesTarget
        ]
      },
      labels: {
        ...createLabels(),
        empty: "What can Codex help you with?",
        emptyProvider: "Codex",
        providerSwitchLabel: "Switch provider",
        handoffConversation: "Handoff",
        handoffConversationTooltip: "Hand off to another agent",
        handoffConversationMenu: "Choose agent"
      }
    });

    ensurePointerCaptureApi();

    const providerSelect = screen.getByRole("combobox", {
      name: "Switch provider"
    });
    fireEvent.keyDown(providerSelect, { key: "ArrowDown" });

    expect(await screen.findByRole("option", { name: "Codex" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeVisible();
    expect(
      screen.getByRole("option", { name: disabledTuttiTarget.label })
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: disabledHermesTarget.label })
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("option", { name: disabledTuttiTarget.label })
    );
    expect(actions.selectHomeComposerAgentTarget).toHaveBeenCalledWith({
      provider: disabledTuttiTarget.provider,
      agentTargetId: disabledTuttiTarget.targetId
    });
  });

  it("keeps the empty-home carousel and provider select in sync with Agent management", async () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    const cursorTarget = createLocalAgentGUIAgentTarget("cursor");
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "What can Claude Code help you with?",
        emptyProvider: "Claude Code"
      },
      viewModel: {
        ...createViewModel(),
        selectedAgentTarget: claudeTarget,
        agentTargets: [codexTarget, claudeTarget, cursorTarget]
      }
    });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));
    const availableGrid = screen.getByRole("list", {
      name: "manageAgentsAvailable"
    });
    const codexManagerTile = within(availableGrid).getAllByTestId(
      "agent-gui-provider-manager-tile"
    )[0]!;
    fireEvent.pointerDown(codexManagerTile, {
      button: 0,
      clientX: 20,
      clientY: 20,
      pointerId: 1
    });
    fireEvent.animationEnd(codexManagerTile, {
      animationName: "agent-gui-provider-manager-long-press"
    });
    fireEvent.click(
      screen.getByRole("button", { name: "removeAgentFromSidebar:Codex" })
    );

    expect(
      screen.queryByRole("button", { name: "Switch provider: Codex" })
    ).toBeNull();
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "manageAgentsTitle" })
      ).getByRole("button", { name: "Close" })
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "manageAgentsTitle" })
      ).toBeNull();
    });

    const providerSelect = screen.getByRole("combobox", {
      name: "Switch provider"
    });
    fireEvent.keyDown(providerSelect, { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: "Codex" })).toBeNull();
    expect(
      await screen.findByRole("option", { name: "Claude Code" })
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Cursor" })).toBeVisible();
    fireEvent.keyDown(providerSelect, { key: "Escape" });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));
    const reopenedAvailableGrid = screen.getByRole("list", {
      name: "manageAgentsAvailable"
    });
    fireEvent.keyDown(
      within(reopenedAvailableGrid).getAllByTestId(
        "agent-gui-provider-manager-tile"
      )[0]!,
      { key: "Enter" }
    );
    fireEvent.click(
      screen.getByRole("button", { name: "addAgentToSidebar:Codex" })
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "manageAgentsTitle" })
      ).getByRole("button", { name: "Close" })
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "manageAgentsTitle" })
      ).toBeNull();
    });

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Switch provider" }),
      { key: "ArrowDown" }
    );
    expect(await screen.findByRole("option", { name: "Codex" })).toBeVisible();
  });

  it("falls back to a visible Agent when the selected empty-home Agent is hidden", async () => {
    const actions = createActions();
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      labels: {
        ...createLabels(),
        empty: "What can Codex help you with?",
        emptyProvider: "Codex"
      },
      viewModel: {
        ...createViewModel(),
        selectedAgentTarget: codexTarget,
        agentTargets: [codexTarget, claudeTarget]
      }
    });

    fireEvent.click(screen.getByTitle("agentConfig"));
    fireEvent.click(screen.getByRole("button", { name: "manageAgents" }));
    const availableGrid = screen.getByRole("list", {
      name: "manageAgentsAvailable"
    });
    const codexManagerTile = within(availableGrid).getAllByTestId(
      "agent-gui-provider-manager-tile"
    )[0]!;
    fireEvent.pointerDown(codexManagerTile, {
      button: 0,
      clientX: 20,
      clientY: 20,
      pointerId: 1
    });
    fireEvent.animationEnd(codexManagerTile, {
      animationName: "agent-gui-provider-manager-long-press"
    });
    fireEvent.click(
      screen.getByRole("button", { name: "removeAgentFromSidebar:Codex" })
    );
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "manageAgentsTitle" })
      ).getByRole("button", { name: "Close" })
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "manageAgentsTitle" })
      ).toBeNull();
    });

    expect(
      screen.getByRole("heading", {
        name: "What can Claude Code help you with?"
      })
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Switch provider: Codex" })
    ).toBeNull();
    await waitFor(() => {
      expect(actions.selectHomeComposerAgentTarget).toHaveBeenCalledWith({
        provider: "claude-code",
        agentTargetId: claudeTarget.targetId
      });
    });
  });

  it("requests composer focus after switching the empty hero provider select", async () => {
    const actions = createActions();
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        selectedAgentTarget: codexTarget,
        agentTargets: [codexTarget, claudeTarget]
      },
      labels: {
        ...createLabels(),
        empty: "What can Codex help you with?",
        emptyProvider: "Codex",
        providerSwitchLabel: "Switch provider"
      }
    });

    expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBeNull();

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Switch provider" }),
      { key: "ArrowDown" }
    );
    fireEvent.click(await screen.findByRole("option", { name: "Claude Code" }));

    expect(actions.selectHomeComposerAgentTarget).toHaveBeenCalledWith({
      provider: "claude-code",
      agentTargetId: claudeTarget.targetId
    });
    await waitFor(() => {
      expect(composerMock.calls.at(-1)?.composerFocusRequestSequence).toBe(1);
    });
  });

  it("selects the All tile for daemon local Codex targets", () => {
    const daemonCodexTarget = {
      ...createLocalAgentGUIAgentTarget("codex"),
      targetId: "local-codex"
    };

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        selectedAgentTarget: daemonCodexTarget,
        agentTargets: [
          daemonCodexTarget,
          {
            ...createLocalAgentGUIAgentTarget("claude-code"),
            targetId: "local-claude-code"
          }
        ]
      }
    });

    expect(screen.getByRole("tab", { name: "All" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "Codex" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("shows provider target loading placeholders without static catalog tiles", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [],
        agentTargetsLoading: true
      }
    });

    expect(screen.getByRole("tablist")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Codex" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Claude Code" })).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("synthesizes local provider rail tiles when provider targets load empty", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: [],
        agentTargetsLoading: false
      }
    });

    expect(screen.getByRole("tablist")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Codex" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Claude Code" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Cursor" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Tutti Agent" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "OpenCode" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Nexight" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Hermes Agent" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "OpenClaw" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Hermes Agent" })
    ).not.toBeDisabled();
    expect(screen.getByRole("tab", { name: "OpenClaw" })).not.toBeDisabled();
    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    ).toEqual([
      "All",
      "Codex",
      "Claude Code",
      "Cursor",
      "Tutti Agent",
      "OpenCode",
      "Nexight",
      "Hermes Agent",
      "OpenClaw"
    ]);
  });

  it("renders exactly the provided targets in exact rail mode", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        providerRailMode: "exact",
        agentTargets: [
          {
            targetId: "shared-agent:alice-codex",
            provider: "codex",
            ref: {
              kind: "shared-agent",
              provider: "codex",
              sharedAgentId: "alice-codex"
            },
            label: "Alice's Codex"
          },
          {
            targetId: "shared-agent:bob-claude",
            provider: "claude-code",
            ref: {
              kind: "shared-agent",
              provider: "claude-code",
              sharedAgentId: "bob-claude"
            },
            label: "Bob's Claude"
          }
        ],
        agentTargetsLoading: false
      }
    });

    // "All" tile + exactly the two shared agents — no placeholders, no padding.
    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    ).toEqual(["All", "Alice's Codex", "Bob's Claude"]);
    expect(screen.queryByRole("tab", { name: "Cursor" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Hermes" })).toBeNull();
  });

  it("renders provider target badges on rail tiles", () => {
    const { container } = renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        providerRailMode: "exact",
        agentTargets: [
          {
            targetId: "shared-agent:alice-codex",
            provider: "codex",
            ref: {
              kind: "shared-agent",
              provider: "codex",
              sharedAgentId: "alice-codex"
            },
            label: "Alice's Codex",
            badge: {
              iconUrl: "app://alice-avatar.png",
              label: "Alice avatar"
            }
          }
        ],
        agentTargetsLoading: false
      }
    });

    expect(
      screen.getByRole("tab", { name: "Alice's Codex, Alice avatar" })
    ).toBeInTheDocument();
    expect(
      container.querySelector(".agent-gui-node__agent-avatar-badge")
    ).not.toBeNull();
    expect(
      container
        .querySelector<HTMLImageElement>(
          ".agent-gui-node__agent-avatar-badge-image"
        )
        ?.getAttribute("src")
    ).toBe("app://alice-avatar.png");
  });

  it("preserves the host-provided target order in exact rail mode", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        providerRailMode: "exact",
        // claude-code first, then codex — the built-in provider order would flip
        // these; exact mode must keep the caller's order.
        agentTargets: [
          {
            targetId: "shared-agent:bob-claude",
            provider: "claude-code",
            ref: {
              kind: "shared-agent",
              provider: "claude-code",
              sharedAgentId: "bob-claude"
            },
            label: "Bob's Claude"
          },
          {
            targetId: "shared-agent:alice-codex",
            provider: "codex",
            ref: {
              kind: "shared-agent",
              provider: "codex",
              sharedAgentId: "alice-codex"
            },
            label: "Alice's Codex"
          }
        ],
        agentTargetsLoading: false
      }
    });

    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    ).toEqual(["All", "Bob's Claude", "Alice's Codex"]);
  });

  it("renders the host empty state in exact rail mode when no targets are provided", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        providerRailMode: "exact",
        agentTargets: [],
        agentTargetsLoading: false
      },
      renderProviderRailEmpty: () => (
        <div data-testid="exact-rail-empty">No shared agents</div>
      )
    });

    expect(screen.getByTestId("exact-rail-empty")).toBeInTheDocument();
    // No static local catalog fallback.
    expect(screen.queryByRole("tab", { name: "Codex" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Cursor" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "All" })).toBeNull();
  });

  it("keeps the provider rail to the default agent tiles for static provider catalogs", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        agentTargets: createLocalAgentGUIAgentTargets(),
        agentTargetsLoading: false
      }
    });

    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    ).toEqual([
      "All",
      "Codex",
      "Claude Code",
      "Cursor",
      "Tutti Agent",
      "OpenCode",
      "Nexight",
      "Hermes Agent",
      "OpenClaw"
    ]);
  });

  it("falls back to All for avatar rail targets without an agent target id", () => {
    const actions = createActions();
    const localHermesTarget = {
      ...createLocalAgentGUIAgentTarget("hermes"),
      label: "Local Hermes"
    };
    const sharedHermesTarget = {
      ...createLocalAgentGUIAgentTarget("hermes"),
      targetId: "shared-agent:hermes-1",
      label: "Shared Hermes"
    };
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        selectedAgentTarget: sharedHermesTarget,
        agentTargets: [
          createLocalAgentGUIAgentTarget("codex"),
          localHermesTarget,
          sharedHermesTarget
        ]
      }
    });

    const sharedTile = screen.getByRole("tab", { name: "Shared Hermes" });
    expect(sharedTile).toHaveAttribute("aria-selected", "false");

    fireEvent.click(sharedTile);

    expect(actions.selectConversationFilterTarget).toHaveBeenCalledWith({
      provider: "hermes",
      agentTargetId: "shared-agent:hermes-1"
    });
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("passes provider switching options into the multi-provider composer", () => {
    const actions = createActions();
    const agentTargets = [
      createLocalAgentGUIAgentTarget("codex"),
      createLocalAgentGUIAgentTarget("claude-code")
    ];
    renderAgentGUINodeView({
      actions,
      labels: {
        ...createLabels(),
        empty: "What can Codex help you with?",
        emptyProvider: "Codex"
      },
      viewModel: {
        ...createViewModel(),
        agentTargets
      }
    });

    const trigger = screen.getByRole("combobox", { name: "Switch provider" });

    expect(trigger).toHaveClass("agent-gui-node__empty-hero-provider-select");
    expect(trigger).toHaveTextContent("Codex");
  });

  it("renders provider switching options in the localized title", () => {
    const agentTargets = [
      createLocalAgentGUIAgentTarget("codex"),
      createLocalAgentGUIAgentTarget("claude-code")
    ];
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "需要 Codex 帮你做些什么？",
        emptyProvider: "Codex",
        providerSwitchLabel: "切换 Provider",
        handoffConversation: "Handoff",
        handoffConversationTooltip: "交接给其他 Agent",
        handoffConversationMenu: "选择 Agent"
      },
      viewModel: {
        ...createViewModel(),
        agentTargets
      }
    });

    const trigger = screen.getByRole("combobox", { name: "切换 Provider" });

    expect(trigger).toHaveClass("agent-gui-node__empty-hero-provider-select");
    expect(trigger).toHaveTextContent("Codex");
  });

  it("uses Cursor colorful artwork in the empty hero provider select", async () => {
    const agentTargets = [
      createLocalAgentGUIAgentTarget("codex"),
      {
        ...createLocalAgentGUIAgentTarget("cursor"),
        iconUrl: "app://old-cursor-target-icon.png"
      }
    ];
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "What can Cursor help you with?",
        emptyProvider: "Cursor",
        providerSwitchLabel: "Switch provider",
        handoffConversation: "Handoff",
        handoffConversationTooltip: "Hand off to another agent",
        handoffConversationMenu: "Choose agent"
      },
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: agentTargets[1]!.agentTargetId ?? ""
        },
        selectedAgentTarget: agentTargets[1]!,
        agentTargets
      }
    });

    const trigger = screen.getByRole("combobox", {
      name: "Switch provider"
    });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(
      (await screen.findByRole("option", { name: "Cursor" })).querySelector(
        "img"
      )
    ).toHaveAttribute("src", MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.cursor);
  });

  it("uses the host-provided Cursor artwork in the vinyl player", () => {
    const agentTargets = [
      createLocalAgentGUIAgentTarget("codex"),
      {
        ...createLocalAgentGUIAgentTarget("cursor"),
        iconUrl: "app://old-cursor-target-icon.png"
      }
    ];
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "What can Cursor help you with?",
        emptyProvider: "Cursor",
        providerSwitchLabel: "Switch provider",
        handoffConversation: "Handoff",
        handoffConversationTooltip: "Hand off to another agent",
        handoffConversationMenu: "Choose agent"
      },
      viewModel: createViewModel({
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: agentTargets[1]!.agentTargetId ?? ""
        },
        selectedAgentTarget: agentTargets[1]!,
        agentTargets
      })
    });

    expect(
      document.querySelector(".agent-gui-vinyl-player__label img")
    ).toHaveAttribute("src", "app://old-cursor-target-icon.png");
  });

  it("renders the composer from the selected provider target", () => {
    const agentTargets = [
      createLocalAgentGUIAgentTarget("codex"),
      createLocalAgentGUIAgentTarget("claude-code")
    ];
    const selectedAgentTarget = createLocalAgentGUIAgentTarget("claude-code");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        data: {
          provider: "codex",
          agentTargetId: "local:codex",
          lastActiveAgentSessionId: null,
          conversationRailWidthPx: null
        },
        agentTargets,
        selectedAgentTarget
      }
    });

    expect(composerMock.calls.at(-1)).toMatchObject({
      provider: "claude-code"
    });
  });

  it("hides provider switching in the title for an active session", () => {
    const agentTargets = [
      createLocalAgentGUIAgentTarget("codex"),
      createLocalAgentGUIAgentTarget("claude-code")
    ];
    const conversation = createConversationSummary("session-1");
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "What can Codex help you with?",
        emptyProvider: "Codex"
      },
      viewModel: {
        ...createViewModel(),
        activeConversation: conversation,
        activeConversationId: conversation.id,
        conversations: [conversation],
        agentTargets
      }
    });

    expect(
      screen.queryByRole("combobox", { name: "Switch provider" })
    ).not.toBeInTheDocument();
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
          ...viewModel.composer.composerSettings,
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
          ...viewModel.composer.composerSettings,
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

  it("disables the toolbar new conversation action for unavailable provider targets", () => {
    const actions = createActions();
    const unavailableTarget = {
      ...createLocalAgentGUIAgentTarget("nexight"),
      disabled: true
    };
    const { container } = renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        selectedAgentTarget: unavailableTarget,
        agentTargets: [unavailableTarget]
      }
    });

    const newConversationButton = container.querySelector<HTMLButtonElement>(
      ".agent-gui-node__new-conversation-icon-button"
    );
    if (!newConversationButton) {
      throw new Error("Expected toolbar new conversation button to render.");
    }

    expect(newConversationButton).toBeDisabled();
    fireEvent.click(newConversationButton);

    expect(actions.createConversation).not.toHaveBeenCalled();
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

  it("groups project sections from the filtered conversations passed into the rail", () => {
    const visibleConversation = {
      ...createConversationSummary("visible-session"),
      cwd: "/workspace/app",
      project: {
        id: "project-app",
        path: "/workspace/app",
        label: "App"
      }
    };
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: "local:codex"
        },
        conversations: [visibleConversation],
        userProjects: [
          {
            id: "project-app",
            path: "/workspace/app",
            label: "App"
          },
          {
            id: "project-api",
            path: "/workspace/api",
            label: "Api"
          }
        ]
      },
      labels: {
        ...createLabels(),
        emptyProjectConversations: "No chats yet"
      }
    });

    expect(screen.getByText("App")).toBeInTheDocument();
    expect(screen.getByText("Api")).toBeInTheDocument();
    expect(screen.getByText("visible-session")).toBeInTheDocument();
    expect(conversationMetaMock.calls).toEqual(["visible-session"]);
    expect(screen.getAllByText("No chats yet")).toHaveLength(2);
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

  it("delays the conversation list skeleton during initial loading", async () => {
    vi.useFakeTimers();

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        isLoadingConversations: true
      }
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.queryByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(299);
    });

    expect(
      screen.queryByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(
      screen.getByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toHaveAccessibleName("loadingConversations");
    expect(screen.queryByText("loadingConversations")).not.toBeInTheDocument();
  });

  it("skips the conversation list skeleton when conversations load within 300ms", async () => {
    vi.useFakeTimers();

    const { rerender } = renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        isLoadingConversations: true
      }
    });
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(299);
    });

    rerender(
      buildAgentGUINodeViewElement({
        viewModel: {
          ...createViewModel(),
          conversations: [createConversationSummary("session-1")]
        }
      })
    );

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(
      screen.queryByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toBeNull();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    ).toBeInTheDocument();
  });

  it("does not render cwd-derived project sections while runtime sections are loading", async () => {
    vi.useFakeTimers();

    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(
      () =>
        new Promise<AgentActivityRuntimeSessionSectionsResult>(() => undefined)
    );

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          kind: "project",
          sectionKey: input.sectionKey,
          userProject: createRuntimeUserProject(project),
          sessions: [],
          hasMore: false
        })
      },
      labels: {
        ...createLabels(),
        loadingConversations: "loadingConversations"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [project],
        conversations: [
          {
            ...createConversationSummary("project-session-1"),
            cwd: "/workspace/app/package-1"
          }
        ]
      }
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.queryByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toBeNull();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(
      screen.getByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toHaveAccessibleName("loadingConversations");
    expect(screen.queryByRole("button", { name: /App/u })).toBeNull();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-project-session-1")
    ).not.toBeInTheDocument();
  });

  it("keeps runtime project sections server-owned when local summaries resolve projects", async () => {
    const project = {
      id: "project-home",
      path: "/Users/ryan",
      label: "ryan"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: [20, 19, 18, 17, 16].map((index) => ({
            ...createRuntimeSession(
              input.workspaceId,
              `session-${index}`,
              "/Users/ryan"
            ),
            updatedAtUnixMs: index
          })),
          hasMore: true,
          nextCursor: "16|session-16",
          workspaceId: input.workspaceId
        })
      ]
    }));

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          kind: "project",
          sectionKey: input.sectionKey,
          userProject: createRuntimeUserProject(project),
          sessions: [],
          hasMore: false
        })
      },
      viewModel: {
        ...createViewModel(),
        activeConversationId: "session-5",
        userProjects: [project],
        conversations: [5, 20, 19, 18, 17].map((index) =>
          createConversationSummary(`session-${index}`, {
            project,
            updatedAtUnixMs: index
          })
        )
      }
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("agent-gui-conversation-item-session-20")
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-5")
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-16")
    ).toBeInTheDocument();
  });

  it("renders pinned conversations from the runtime pinned page", async () => {
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      pinned: {
        hasMore: false,
        sessions: [
          {
            ...{
              activeTurnId: null,
              latestTurnInteractions: [],
              pendingInteractions: []
            },
            ...createRuntimeSession(input.workspaceId, "old-pinned-session"),
            pinnedAtUnixMs: 2000,
            updatedAtUnixMs: 10
          }
        ]
      },
      sections: [
        {
          kind: "conversations",
          sectionKey: "conversations",
          sessions: [],
          hasMore: false
        }
      ]
    }));

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          hasMore: false
        })
      },
      viewModel: {
        ...createViewModel(),
        conversations: []
      }
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("agent-gui-conversation-item-old-pinned-session")
      ).toBeInTheDocument();
    });
  });

  it("loads additional pinned conversations from the runtime pinned page endpoint", async () => {
    const listPinnedSessionsPage = vi.fn<
      NonNullable<AgentActivityRuntime["listPinnedSessionsPage"]>
    >(async (input) => ({
      hasMore: false,
      sessions: [
        {
          ...{
            activeTurnId: null,
            latestTurnInteractions: [],
            pendingInteractions: []
          },
          ...createRuntimeSession(input.workspaceId, "older-pinned-session"),
          pinnedAtUnixMs: 1000,
          updatedAtUnixMs: 5
        }
      ]
    }));
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      pinned: {
        hasMore: true,
        nextCursor: "2000|newer-pinned-session",
        sessions: [
          {
            ...{
              activeTurnId: null,
              latestTurnInteractions: [],
              pendingInteractions: []
            },
            ...createRuntimeSession(input.workspaceId, "newer-pinned-session"),
            pinnedAtUnixMs: 2000,
            updatedAtUnixMs: 10
          }
        ]
      },
      sections: [
        {
          kind: "conversations",
          sectionKey: "conversations",
          sessions: [],
          hasMore: false
        }
      ]
    }));

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listPinnedSessionsPage,
        listSessionSections,
        listSessionSectionPage: async (input) => ({
          kind: "conversations",
          sectionKey: input.sectionKey,
          sessions: [],
          hasMore: false
        })
      },
      viewModel: {
        ...createViewModel(),
        conversations: []
      }
    });

    await screen.findByTestId(
      "agent-gui-conversation-item-newer-pinned-session"
    );
    fireEvent.click(
      screen.getByRole("button", { name: createLabels().showMoreConversations })
    );

    await waitFor(() => {
      expect(listPinnedSessionsPage).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: "2000|newer-pinned-session",
          limit: 5,
          workspaceId: "room-1"
        })
      );
    });
    expect(
      await screen.findByTestId(
        "agent-gui-conversation-item-older-pinned-session"
      )
    ).toBeInTheDocument();
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

  it("opens a conversation from the rail context menu without selecting", async () => {
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

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-2")
    );
    const openWindowMenuItem = await screen.findByRole("menuitem", {
      name: "openConversationWindow"
    });
    fireEvent.pointerUp(openWindowMenuItem, { button: 0 });

    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", { name: "openConversationWindow" })
      ).not.toBeInTheDocument()
    );

    await waitFor(() =>
      expect(onOpenConversationWindow).toHaveBeenCalledTimes(1)
    );
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

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-10")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-11")
    ).not.toBeInTheDocument();

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

  it("keeps the active conversation visible when a section is collapsed back to its first page", () => {
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more",
        showLessConversations: "Show less"
      },
      viewModel: {
        ...createViewModel(),
        activeConversationId: "session-12",
        conversations: Array.from({ length: 10 }, (_, index) =>
          createConversationSummary(`session-${20 - index}`)
        )
      }
    });

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-20")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-16")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-12")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-15")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-13")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-12")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-11")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));

    expect(
      screen.getByTestId("agent-gui-conversation-item-session-16")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-12")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-session-15")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show more" })
    ).toBeInTheDocument();
  });

  it("loads more project rail sessions through the runtime section page", async () => {
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: [
            {
              ...{
                activeTurnId: null,
                latestTurnInteractions: [],
                pendingInteractions: []
              },
              ...createRuntimeSession(
                input.workspaceId,
                "project-session-1",
                "/workspace/app/package-1"
              ),
              updatedAtUnixMs: 100
            },
            {
              ...createRuntimeSession(
                input.workspaceId,
                "project-session-3",
                "/workspace/app/package-3"
              ),
              updatedAtUnixMs: 90
            },
            {
              ...createRuntimeSession(
                input.workspaceId,
                "project-session-4",
                "/workspace/app/package-4"
              ),
              updatedAtUnixMs: 80
            },
            {
              ...createRuntimeSession(
                input.workspaceId,
                "project-session-5",
                "/workspace/app/package-5"
              ),
              updatedAtUnixMs: 70
            },
            {
              ...createRuntimeSession(
                input.workspaceId,
                "project-session-2",
                "/workspace/app/package-2"
              ),
              updatedAtUnixMs: 10
            }
          ],
          hasMore: true,
          nextCursor: "10|project-session-2",
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(async (input) => ({
      kind: "project",
      sectionKey: input.sectionKey,
      userProject: createRuntimeUserProject(project),
      hasMore: false,
      sessions: [
        {
          ...{
            activeTurnId: null,
            latestTurnInteractions: [],
            pendingInteractions: []
          },
          ...createRuntimeSession(
            input.workspaceId,
            "project-extra",
            "/workspace/app/packages/web"
          ),
          updatedAtUnixMs: 5
        }
      ]
    }));
    const activityRuntime = {
      ...createNoopAgentActivityRuntime(),
      listSessionSections,
      listSessionSectionPage
    };

    renderAgentGUINodeView({
      activityRuntime,
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [project],
        conversations: []
      }
    });
    const projectSectionButton = await screen.findByRole("button", {
      name: /App/u
    });
    const projectSection = projectSectionButton.closest(
      ".agent-gui-node__conversation-section"
    );
    if (!projectSection) {
      throw new Error("Expected project section to render.");
    }

    fireEvent.click(
      within(projectSection as HTMLElement).getByRole("button", {
        name: "Show more"
      })
    );

    await waitFor(() => {
      expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    });
    expect(listSessionSectionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: "10|project-session-2",
        limit: 5,
        sectionKey: "project:/workspace/app",
        signal: expect.any(AbortSignal),
        workspaceId: "room-1"
      })
    );
    expect(
      await screen.findByTestId("agent-gui-conversation-item-project-extra")
    ).toBeInTheDocument();
  });

  it("refetches runtime rail sections only for provider changes, not conversation summary updates", async () => {
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeConversationsSection({
          sessions: [
            {
              ...{
                activeTurnId: null,
                latestTurnInteractions: [],
                pendingInteractions: []
              },
              ...createRuntimeSession(input.workspaceId, "session-1"),
              title: "Initial title",
              updatedAtUnixMs: 100
            }
          ],
          hasMore: false
        })
      ]
    }));
    const activityRuntime = {
      ...createNoopAgentActivityRuntime(),
      listSessionSections,
      listSessionSectionPage: async (
        input: Parameters<
          NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
        >[0]
      ) => ({
        kind: "conversations" as const,
        sectionKey: input.sectionKey,
        sessions: [],
        hasMore: false
      })
    };
    const initialConversation = {
      ...createConversationSummary("session-1"),
      title: "Initial title",
      updatedAtUnixMs: 100
    };
    const baseViewModel = createViewModel();
    const viewModel = createViewModel({
      data: {
        ...baseViewModel.shell.data,
        provider: "claude-code" as const
      },
      selectedAgentTarget: createLocalAgentGUIAgentTarget("claude-code"),
      conversations: [initialConversation]
    });
    const labels = createLabels();
    const rendered = renderAgentGUINodeView({
      activityRuntime,
      labels,
      viewModel
    });

    await waitFor(() => {
      expect(listSessionSections).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    ).toHaveTextContent("Initial title");

    const updatedConversation = {
      ...initialConversation,
      status: "working" as const,
      title: "Updated title",
      updatedAtUnixMs: 200
    };
    rendered.rerender(
      buildAgentGUINodeViewElement({
        activityRuntime,
        labels: { ...labels },
        viewModel: {
          ...viewModel,
          activeConversation: updatedConversation,
          activeConversationId: updatedConversation.id,
          conversations: [updatedConversation]
        }
      })
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("agent-gui-conversation-item-session-1")
      ).toHaveTextContent("Updated title");
    });
    expect(listSessionSections).toHaveBeenCalledTimes(1);
    expect(listSessionSections).toHaveBeenCalledWith(
      expect.objectContaining({ agentTargetId: "local:claude-code" })
    );

    rendered.rerender(
      buildAgentGUINodeViewElement({
        activityRuntime,
        labels: { ...labels },
        viewModel: {
          ...viewModel,
          data: {
            ...viewModel.shell.data,
            provider: "codex" as const
          },
          selectedAgentTarget: createLocalAgentGUIAgentTarget("codex"),
          activeConversation: updatedConversation,
          activeConversationId: updatedConversation.id,
          conversations: [updatedConversation]
        }
      })
    );

    await waitFor(() => {
      expect(listSessionSections).toHaveBeenCalledTimes(2);
    });
    expect(listSessionSections).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentTargetId: "local:codex" })
    );
  });

  it("keeps the project rail header mounted before slow provider-filtered reloads show a skeleton", async () => {
    const codexTarget = createLocalAgentGUIAgentTarget("codex");
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    const claudeAgentTargetId = claudeTarget.agentTargetId ?? "";
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >((input) => {
      if (input.agentTargetId === claudeAgentTargetId) {
        return new Promise<AgentActivityRuntimeSessionSectionsResult>(
          () => undefined
        );
      }
      return Promise.resolve({
        workspaceId: input.workspaceId,
        sections: [
          createRuntimeProjectSection({
            project,
            sessions: [
              {
                ...{
                  activeTurnId: null,
                  latestTurnInteractions: [],
                  pendingInteractions: []
                },
                ...createRuntimeSession(
                  input.workspaceId,
                  "codex-project-session",
                  "/workspace/app/package",
                  {
                    agentTargetId: codexTarget.agentTargetId ?? undefined,
                    provider: "codex"
                  }
                ),
                updatedAtUnixMs: 100
              }
            ],
            hasMore: false,
            workspaceId: input.workspaceId
          })
        ]
      });
    });
    const activityRuntime = {
      ...createNoopAgentActivityRuntime(),
      listSessionSections,
      listSessionSectionPage: async (
        input: Parameters<
          NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
        >[0]
      ) => ({
        kind: "project" as const,
        sectionKey: input.sectionKey,
        userProject: createRuntimeUserProject(project),
        sessions: [],
        hasMore: false
      })
    };
    const labels = createLabels();
    const baseViewModel = {
      ...createViewModel(),
      selectedAgentTarget: codexTarget,
      agentTargets: [codexTarget, claudeTarget],
      userProjects: [project],
      conversations: []
    };
    const rendered = renderAgentGUINodeView({
      activityRuntime,
      labels,
      viewModel: baseViewModel
    });

    expect(
      await screen.findByTestId(
        "agent-gui-conversation-item-codex-project-session"
      )
    ).toBeInTheDocument();
    const projectHeaderLabel = workspaceUserProjectI18n.tFirst([
      "projectSelect.projectLabel"
    ]);
    const projectHeader = screen
      .getByText(projectHeaderLabel)
      .closest(".agent-gui-node__project-rail-header");
    expect(projectHeader).not.toBeNull();

    vi.useFakeTimers();
    rendered.rerender(
      buildAgentGUINodeViewElement({
        activityRuntime,
        labels,
        viewModel: {
          ...baseViewModel,
          conversationFilter: {
            kind: "agentTarget",
            agentTargetId: claudeAgentTargetId
          },
          selectedAgentTarget: claudeTarget
        }
      })
    );

    expect(listSessionSections).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(listSessionSections).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentTargetId: claudeAgentTargetId })
    );
    expect(
      screen.queryByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toBeNull();
    expect(
      screen.getByTestId("agent-gui-conversation-item-codex-project-session")
    ).toBeInTheDocument();
    expect(
      screen
        .getByText(projectHeaderLabel)
        .closest(".agent-gui-node__project-rail-header")
    ).toBe(projectHeader);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(
      screen.getByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-codex-project-session")
    ).not.toBeInTheDocument();
  });

  it("passes the active agent target filter to runtime rail section requests", async () => {
    const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
    const agentTargetId = claudeTarget.agentTargetId ?? "";
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: [
            {
              ...{
                activeTurnId: null,
                latestTurnInteractions: [],
                pendingInteractions: []
              },
              ...createRuntimeSession(
                input.workspaceId,
                "project-session-1",
                "/workspace/app/package-1",
                { agentTargetId, provider: "claude-code" }
              ),
              updatedAtUnixMs: 100
            }
          ],
          hasMore: true,
          nextCursor: "100|project-session-1",
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(async (input) => ({
      kind: "project",
      sectionKey: input.sectionKey,
      userProject: createRuntimeUserProject(project),
      hasMore: false,
      sessions: [
        {
          ...{
            activeTurnId: null,
            latestTurnInteractions: [],
            pendingInteractions: []
          },
          ...createRuntimeSession(
            input.workspaceId,
            "project-extra",
            "/workspace/app/older",
            { agentTargetId, provider: "claude-code" }
          ),
          updatedAtUnixMs: 90
        }
      ]
    }));

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage
      },
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "agentTarget", agentTargetId },
        selectedAgentTarget: claudeTarget,
        agentTargets: [createLocalAgentGUIAgentTarget("codex"), claudeTarget],
        userProjects: [project],
        conversations: []
      }
    });

    const projectSectionButton = await screen.findByRole("button", {
      name: /App/u
    });
    await waitFor(() => {
      expect(listSessionSections).toHaveBeenCalledWith(
        expect.objectContaining({
          agentTargetId,
          limitPerSection: 5,
          workspaceId: "room-1"
        })
      );
    });
    const projectSection = projectSectionButton.closest(
      ".agent-gui-node__conversation-section"
    );
    if (!projectSection) {
      throw new Error("Expected project section to render.");
    }

    fireEvent.click(
      within(projectSection as HTMLElement).getByRole("button", {
        name: "Show more"
      })
    );

    await waitFor(() => {
      expect(listSessionSectionPage).toHaveBeenCalledWith(
        expect.objectContaining({
          agentTargetId,
          cursor: "100|project-session-1",
          sectionKey: "project:/workspace/app",
          workspaceId: "room-1"
        })
      );
    });
  });

  it("renders an empty project runtime section without Show more when hasMore is false", async () => {
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: [],
          hasMore: false,
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage =
      vi.fn<NonNullable<AgentActivityRuntime["listSessionSectionPage"]>>();

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage
      },
      labels: {
        ...createLabels(),
        emptyProjectConversations: "No chats yet",
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [project],
        conversations: []
      }
    });
    const projectSectionButton = await screen.findByRole("button", {
      name: /App/u
    });
    const projectSection = projectSectionButton.closest(
      ".agent-gui-node__conversation-section"
    );
    if (!projectSection) {
      throw new Error("Expected project section to render.");
    }

    expect(
      within(projectSection as HTMLElement).getByText("No chats yet")
    ).toBeInTheDocument();
    expect(
      within(projectSection as HTMLElement).queryByRole("button", {
        name: "Show more"
      })
    ).not.toBeInTheDocument();
    expect(listSessionSectionPage).not.toHaveBeenCalled();
  });

  it("loads more ordinary rail sessions through the conversations section page", async () => {
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: [],
          hasMore: false,
          workspaceId: input.workspaceId
        }),
        createRuntimeConversationsSection({
          sessions: Array.from({ length: 5 }, (_, index) => ({
            ...createRuntimeSession(
              input.workspaceId,
              `chat-session-${index + 1}`,
              `/scratch/chat-${index + 1}`
            ),
            updatedAtUnixMs: 100 - index
          })),
          hasMore: true,
          nextCursor: "96|chat-session-5"
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(async (input) => ({
      kind: "conversations",
      sectionKey: input.sectionKey,
      hasMore: false,
      sessions: [
        {
          ...{
            activeTurnId: null,
            latestTurnInteractions: [],
            pendingInteractions: []
          },
          ...createRuntimeSession(
            input.workspaceId,
            "chat-extra",
            "/scratch/outside-project"
          ),
          updatedAtUnixMs: 40
        }
      ]
    }));
    const activityRuntime = {
      ...createNoopAgentActivityRuntime(),
      listSessionSections,
      listSessionSectionPage
    };

    const { container } = renderAgentGUINodeView({
      activityRuntime,
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [project],
        conversations: []
      }
    });
    const conversationsSection = await waitFor(() => {
      const section = container.querySelector(
        '.agent-gui-node__conversation-section[data-kind="conversations"]'
      );
      if (!section) {
        throw new Error("Expected conversations section to render.");
      }
      return section;
    });
    if (!conversationsSection) {
      throw new Error("Expected conversations section to render.");
    }

    fireEvent.click(
      within(conversationsSection as HTMLElement).getByRole("button", {
        name: "Show more"
      })
    );

    await waitFor(() => {
      expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    });
    expect(listSessionSectionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: "96|chat-session-5",
        limit: 5,
        signal: expect.any(AbortSignal),
        sectionKey: "conversations",
        workspaceId: "room-1"
      })
    );
    expect(
      await screen.findByTestId("agent-gui-conversation-item-chat-extra")
    ).toBeInTheDocument();
  });

  it("offers runtime paging when a project section has fewer than five local sessions", async () => {
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: Array.from({ length: 2 }, (_, index) => ({
            ...createRuntimeSession(
              input.workspaceId,
              `project-session-${index + 1}`,
              `/workspace/app/package-${index + 1}`
            ),
            updatedAtUnixMs: 100 - index
          })),
          hasMore: true,
          nextCursor: "99|project-session-2",
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(async (input) => ({
      kind: "project",
      sectionKey: input.sectionKey,
      userProject: createRuntimeUserProject(project),
      hasMore: false,
      sessions: [
        {
          ...{
            activeTurnId: null,
            latestTurnInteractions: [],
            pendingInteractions: []
          },
          ...createRuntimeSession(
            input.workspaceId,
            "project-third",
            "/workspace/app/older"
          ),
          updatedAtUnixMs: 80
        }
      ]
    }));

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage
      },
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [project],
        conversations: []
      }
    });
    const projectSectionButton = await screen.findByRole("button", {
      name: /App/u
    });
    const projectSection = projectSectionButton.closest(
      ".agent-gui-node__conversation-section"
    );
    if (!projectSection) {
      throw new Error("Expected project section to render.");
    }

    fireEvent.click(
      within(projectSection as HTMLElement).getByRole("button", {
        name: "Show more"
      })
    );

    await waitFor(() => {
      expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    });
    expect(listSessionSectionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: "99|project-session-2",
        sectionKey: "project:/workspace/app"
      })
    );
    expect(
      await screen.findByTestId("agent-gui-conversation-item-project-third")
    ).toBeInTheDocument();
  });

  it("pages a parent project section by section key", async () => {
    const parentProject = {
      id: "project-root",
      path: "/workspace",
      label: "Workspace"
    };
    const childProject = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project: parentProject,
          sessions: Array.from({ length: 5 }, (_, index) => ({
            ...createRuntimeSession(
              input.workspaceId,
              `parent-session-${index + 1}`,
              `/workspace/package-${index + 1}`
            ),
            updatedAtUnixMs: 100 - index
          })),
          hasMore: true,
          nextCursor: "96|parent-session-5",
          workspaceId: input.workspaceId
        }),
        createRuntimeProjectSection({
          project: childProject,
          sessions: [],
          hasMore: false,
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(async (input) => ({
      kind: "project",
      sectionKey: input.sectionKey,
      userProject: createRuntimeUserProject(parentProject),
      hasMore: false,
      sessions: []
    }));

    renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage
      },
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [parentProject, childProject],
        conversations: []
      }
    });
    const parentSectionButton = await screen.findByRole("button", {
      name: /Workspace/u
    });
    const parentSection = parentSectionButton.closest(
      ".agent-gui-node__conversation-section"
    );
    if (!parentSection) {
      throw new Error("Expected parent project section to render.");
    }

    fireEvent.click(
      within(parentSection as HTMLElement).getByRole("button", {
        name: "Show more"
      })
    );

    await waitFor(() => {
      expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    });
    expect(listSessionSectionPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: "96|parent-session-5",
        sectionKey: "project:/workspace"
      })
    );
  });

  it("aborts and ignores stale runtime paging when the rail scope changes", async () => {
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const deferredPage: {
      resolve?: (page: AgentActivityRuntimeSessionSection) => void;
    } = {};
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: Array.from({ length: 5 }, (_, index) => ({
            ...createRuntimeSession(
              input.workspaceId,
              `project-session-${index + 1}`,
              `/workspace/app/package-${index + 1}`
            ),
            updatedAtUnixMs: 100 - index
          })),
          hasMore: true,
          nextCursor: "96|project-session-5",
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(
      () =>
        new Promise((resolve) => {
          deferredPage.resolve = resolve;
        })
    );
    const activityRuntime = {
      ...createNoopAgentActivityRuntime(),
      listSessionSections,
      listSessionSectionPage
    };
    const { rerender } = renderAgentGUINodeView({
      activityRuntime,
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [project],
        conversations: []
      }
    });

    const projectSectionButton = await screen.findByRole("button", {
      name: /App/u
    });
    const projectSection = projectSectionButton.closest(
      ".agent-gui-node__conversation-section"
    );
    if (!projectSection) {
      throw new Error("Expected project section to render.");
    }

    fireEvent.click(
      within(projectSection as HTMLElement).getByRole("button", {
        name: "Show more"
      })
    );
    await waitFor(() => {
      expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    });
    const signal = listSessionSectionPage.mock.calls[0]?.[0].signal;

    rerender(
      buildAgentGUINodeViewElement({
        activityRuntime,
        labels: {
          ...createLabels(),
          showMoreConversations: "Show more"
        },
        viewModel: {
          ...createViewModel({ workspaceId: "room-2" }),
          userProjects: [project],
          conversations: []
        }
      })
    );

    expect(signal?.aborted).toBe(true);
    deferredPage.resolve?.({
      kind: "project",
      sectionKey: "project:/workspace/app",
      userProject: createRuntimeUserProject(project),
      hasMore: false,
      sessions: [
        {
          ...{
            activeTurnId: null,
            latestTurnInteractions: [],
            pendingInteractions: []
          },
          ...createRuntimeSession(
            "room-1",
            "stale-project-extra",
            "/workspace/app/older"
          ),
          updatedAtUnixMs: 80
        }
      ]
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("agent-gui-conversation-item-stale-project-extra")
      ).not.toBeInTheDocument();
    });
  });

  it("aborts runtime paging when the rail unmounts", async () => {
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: Array.from({ length: 5 }, (_, index) => ({
            ...createRuntimeSession(
              input.workspaceId,
              `project-session-${index + 1}`,
              `/workspace/app/package-${index + 1}`
            ),
            updatedAtUnixMs: 100 - index
          })),
          hasMore: true,
          nextCursor: "96|project-session-5",
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(() => new Promise<AgentActivityRuntimeSessionSection>(() => undefined));
    const { unmount } = renderAgentGUINodeView({
      activityRuntime: {
        ...createNoopAgentActivityRuntime(),
        listSessionSections,
        listSessionSectionPage
      },
      labels: {
        ...createLabels(),
        showMoreConversations: "Show more"
      },
      viewModel: {
        ...createViewModel(),
        userProjects: [project],
        conversations: []
      }
    });

    const projectSectionButton = await screen.findByRole("button", {
      name: /App/u
    });
    const projectSection = projectSectionButton.closest(
      ".agent-gui-node__conversation-section"
    );
    if (!projectSection) {
      throw new Error("Expected project section to render.");
    }

    fireEvent.click(
      within(projectSection as HTMLElement).getByRole("button", {
        name: "Show more"
      })
    );
    await waitFor(() => {
      expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
    });
    const signal = listSessionSectionPage.mock.calls[0]?.[0].signal;

    unmount();

    expect(signal?.aborted).toBe(true);
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

  it("does not scroll the active conversation again after loading more rail sessions", async () => {
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const project = {
      id: "project-app",
      path: "/workspace/app",
      label: "App"
    };
    const listSessionSections = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSections"]>
    >(async (input) => ({
      workspaceId: input.workspaceId,
      sections: [
        createRuntimeProjectSection({
          project,
          sessions: Array.from({ length: 5 }, (_, index) => ({
            ...createRuntimeSession(
              input.workspaceId,
              `project-session-${index + 1}`,
              `/workspace/app/package-${index + 1}`
            ),
            updatedAtUnixMs: 100 - index
          })),
          hasMore: true,
          nextCursor: "96|project-session-5",
          workspaceId: input.workspaceId
        })
      ]
    }));
    const listSessionSectionPage = vi.fn<
      NonNullable<AgentActivityRuntime["listSessionSectionPage"]>
    >(async (input) => ({
      kind: "project",
      sectionKey: input.sectionKey,
      userProject: createRuntimeUserProject(project),
      hasMore: false,
      sessions: [
        {
          ...{
            activeTurnId: null,
            latestTurnInteractions: [],
            pendingInteractions: []
          },
          ...createRuntimeSession(
            input.workspaceId,
            "project-extra",
            "/workspace/app/older"
          ),
          updatedAtUnixMs: 80
        }
      ]
    }));

    try {
      renderAgentGUINodeView({
        activityRuntime: {
          ...createNoopAgentActivityRuntime(),
          listSessionSections,
          listSessionSectionPage
        },
        labels: {
          ...createLabels(),
          showMoreConversations: "Show more"
        },
        viewModel: {
          ...createViewModel(),
          activeConversation: {
            ...createConversationSummary("project-session-1"),
            cwd: "/workspace/app/package-1",
            project
          },
          activeConversationId: "project-session-1",
          userProjects: [project],
          conversations: []
        }
      });
      const projectSectionButton = await screen.findByRole("button", {
        name: /App/u
      });

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      });
      const projectSection = projectSectionButton.closest(
        ".agent-gui-node__conversation-section"
      );
      if (!projectSection) {
        throw new Error("Expected project section to render.");
      }

      fireEvent.click(
        within(projectSection as HTMLElement).getByRole("button", {
          name: "Show more"
        })
      );

      await waitFor(() => {
        expect(listSessionSectionPage).toHaveBeenCalledTimes(1);
      });
      expect(
        await screen.findByTestId("agent-gui-conversation-item-project-extra")
      ).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    }
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

  it("keeps the composer busy from the controller active-turn state when rows are stale", () => {
    const activeConversation = createConversationSummary("session-1");

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation,
        activeConversationId: activeConversation.id,
        activeConversationBusy: true,
        canSubmit: false,
        canQueueWhileBusy: true,
        conversation: null,
        conversationDetail: null,
        isSubmitting: false
      }
    });

    expect(composerMock.calls.at(-1)).toMatchObject({
      isSendingTurn: true,
      showStopButton: true
    });
  });

  it("patches existing project items without inserting local project summaries", () => {
    const project = { id: "ryan", label: "ryan", path: "/Users/ryan" };
    const existingSection = {
      id: "project:/Users/ryan",
      kind: "project" as const,
      label: "ryan",
      project,
      items: [5, 4, 3, 2, 1].map((index) =>
        createConversationSummary(`session-${index}`, {
          project,
          updatedAtUnixMs: index
        })
      )
    };

    const updated = updateConversationSectionsFromSummaries(
      [existingSection],
      [5, 20, 19, 18, 17].map((index) =>
        createConversationSummary(`session-${index}`, {
          project,
          updatedAtUnixMs: index
        })
      ),
      { sectionConversationsLabel: "Conversations" }
    );

    expect(updated?.[0]?.items.map((item) => item.id)).toEqual([
      "session-5",
      "session-4",
      "session-3",
      "session-2",
      "session-1"
    ]);
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

  it("initializes the bottom dock safe area on the timeline scroll area", () => {
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
        .style.getPropertyValue("--agent-gui-bottom-dock-safe-area")
    ).toBe("0px");
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
      gridTemplateColumns: "minmax(0, 1fr)",
      gap: "24px"
    });
  });

  it("marks the timeline as away from top only after scrolling down", () => {
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

    const timeline = screen.getByTestId("agent-gui-timeline") as HTMLElement;

    expect(timeline).not.toHaveClass(
      "agent-gui-node__timeline--scrolled-from-top"
    );

    timeline.scrollTop = 48;
    fireEvent.scroll(timeline);
    expect(timeline).toHaveClass("agent-gui-node__timeline--scrolled-from-top");

    timeline.scrollTop = 0;
    fireEvent.scroll(timeline);
    expect(timeline).not.toHaveClass(
      "agent-gui-node__timeline--scrolled-from-top"
    );
  });

  it("shows a scroll-to-bottom action when the timeline is away from bottom", () => {
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

    const timeline = screen.getByTestId("agent-gui-timeline") as HTMLElement;
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      get: () => 1000
    });
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      get: () => 400
    });
    const scrollTo = vi.spyOn(timeline, "scrollTo");

    timeline.scrollTop = 240;
    fireEvent.scroll(timeline);

    const button = screen.getByTestId("agent-gui-scroll-to-bottom");
    expect(button).toHaveAccessibleName("scrollToBottom");

    fireEvent.click(button);

    expect(scrollTo).toHaveBeenCalledWith({
      top: 600,
      behavior: "smooth"
    });
    expect(screen.queryByTestId("agent-gui-scroll-to-bottom")).toBeNull();
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

  it("scrolls to the bottom after submitting a prompt from the middle of the timeline", () => {
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

    timeline.scrollTop = 240;
    fireEvent.scroll(timeline);

    composerMock.calls.at(-1)?.onSubmit?.([{ type: "text", text: "New ask" }]);
    expect(actions.submitPrompt).toHaveBeenCalledWith([
      { type: "text", text: "New ask" }
    ]);

    scrollHeight = 1240;
    rerender(
      buildAgentGUINodeViewElement({
        actions,
        viewModel: {
          ...activeViewModel,
          conversationDetail: createConversationDetailWithUserMessage("New ask")
        }
      })
    );

    expect(timeline.scrollTop).toBe(840);
  });
});

describe("AgentGUINodeView usage", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  function renderWithUsage(
    usage: AgentGUINodeViewModel["detail"]["usage"],
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

  it("passes background agent waiting status to the composer", () => {
    const activeConversation = createConversationSummary("session-1");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversations: [activeConversation],
        activeConversation,
        activeConversationId: activeConversation.id,
        backgroundAgentCount: 2
      }
    });

    expect(composerMock.calls.at(-1)?.backgroundAgentStatusText).toBe(
      "waitingForBackgroundAgent:2"
    );
  });
});

describe("AgentGUINodeView detail header actions", () => {
  afterEach(() => {
    conversationFlowMock.calls = [];
    composerMock.calls = [];
    statusDotMock.calls = [];
  });

  const usageWithWindow: AgentGUINodeViewModel["detail"]["usage"] = {
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
    return createViewModel({
      conversations: [activeConversation],
      activeConversation,
      activeConversationId: activeConversation.id,
      conversationDetail: {
        ...conversationDetail,
        session: {
          ...conversationDetail.session
        }
      },
      usage: usageWithWindow,
      compactSupported: true
    });
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
    expect(notice).not.toHaveClass("nodrag");
    expect(notice).not.toHaveClass("tsh-desktop-no-drag");
    expect(notice).not.toHaveClass("[-webkit-app-region:no-drag]");
    const action = screen.getByTestId("agent-gui-provider-setup-notice-action");
    expect(action).toHaveTextContent("installRequiredAction");
    expect(action).toHaveClass("nodrag");
    expect(action).toHaveClass("tsh-desktop-no-drag");
    expect(action).toHaveClass("[-webkit-app-region:no-drag]");
  });
  it("hides the setup notice when the provider is ready", () => {
    renderAgentGUINodeView({ isAgentProviderReady: true });

    expect(screen.queryByTestId("agent-gui-provider-setup-notice")).toBeNull();
  });
});

describe("AgentGUINodeView provider readiness gate", () => {
  afterEach(() => {
    composerMock.calls = [];
  });

  it("renders an empty-state gate instead of the composer when the provider is not installed", () => {
    const onAction = vi.fn();
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "What can Codex help you with?",
        emptyProvider: "Codex"
      },
      viewModel: createViewModel({
        providerReadinessGate: {
          status: "not_installed",
          onAction
        }
      })
    });

    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("What can Codex help you with?");
    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("providerGateInstallDescription");
    expect(screen.queryByTestId("agent-gui-provider-setup-notice")).toBeNull();
    expect(screen.queryByTestId("agent-composer")).toBeNull();

    fireEvent.click(
      screen.getByTestId("agent-gui-provider-readiness-gate-action")
    );

    expect(onAction).toHaveBeenCalledWith("codex", "install");
  });

  it("renders a login gate for auth-required providers", () => {
    const onAction = vi.fn();
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "What can Codex help you with?",
        emptyProvider: "Codex"
      },
      viewModel: createViewModel({
        providerReadinessGate: {
          status: "auth_required",
          onAction
        }
      })
    });

    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("What can Codex help you with?");
    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("providerGateLoginDescription");

    const action = screen.getByTestId(
      "agent-gui-provider-readiness-gate-action"
    );
    expect(action).toHaveTextContent("providerGateLoginAction");
    expect(action.querySelector("svg")).toBeNull();

    fireEvent.click(action);

    expect(onAction).toHaveBeenCalledWith("codex", "login");
  });

  it.each(["not_installed", "auth_required"] as const)(
    "keeps the normal copy and agent switcher in the %s readiness gate title",
    async (status) => {
      const actions = createActions();
      const codexTarget = createLocalAgentGUIAgentTarget("codex");
      const claudeTarget = createLocalAgentGUIAgentTarget("claude-code");
      renderAgentGUINodeView({
        actions,
        labels: {
          ...createLabels(),
          empty: "What can Codex help you with?",
          emptyProvider: "Codex",
          providerGateInstallTitle: "Connect Codex first",
          providerGateLoginTitle: "Log in to Codex",
          providerSwitchLabel: "Switch provider"
        },
        viewModel: createViewModel({
          providerReadinessGate: { status },
          selectedAgentTarget: codexTarget,
          agentTargets: [codexTarget, claudeTarget]
        })
      });

      ensurePointerCaptureApi();

      const gate = screen.getByTestId("agent-gui-provider-readiness-gate");
      const providerSelect = within(gate).getByRole("combobox", {
        name: "Switch provider"
      });
      expect(gate).toHaveTextContent("What can Codex help you with?");
      expect(gate).not.toHaveTextContent("Connect Codex first");
      expect(gate).not.toHaveTextContent("Log in to Codex");
      expect(providerSelect).toHaveClass(
        "agent-gui-node__empty-hero-provider-select"
      );

      fireEvent.keyDown(providerSelect, { key: "ArrowDown" });
      fireEvent.click(
        await screen.findByRole("option", { name: "Claude Code" })
      );

      expect(actions.selectHomeComposerAgentTarget).toHaveBeenCalledWith({
        provider: "claude-code",
        agentTargetId: claudeTarget.targetId
      });
    }
  );

  it("renders a disabled action for placeholder provider targets", () => {
    const tuttiTarget = {
      ...createLocalAgentGUIAgentTarget("nexight"),
      disabled: true
    };
    renderAgentGUINodeView({
      viewModel: createViewModel({
        data: {
          provider: "nexight",
          agentTargetId: tuttiTarget.agentTargetId,
          lastActiveAgentSessionId: null,
          conversationRailWidthPx: null
        },
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: tuttiTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: tuttiTarget,
        agentTargets: [createLocalAgentGUIAgentTarget("codex"), tuttiTarget]
      })
    });

    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("providerGateComingSoonTitle");
    const action = screen.getByTestId(
      "agent-gui-provider-readiness-gate-action"
    );
    expect(action).toHaveTextContent("providerGateComingSoonAction");
    expect(action).toBeDisabled();
    expect(screen.queryByTestId("agent-composer")).toBeNull();
  });

  it("lets the host render disabled provider target unavailable state", () => {
    const disabledTarget = {
      ...createLocalAgentGUIAgentTarget("codex"),
      disabled: true,
      label: "Shared Codex",
      unavailableReason: "disabled by workspace policy"
    };
    const renderProviderUnavailableState = vi.fn((ctx) => (
      <div data-testid="custom-provider-unavailable">
        {ctx.providerLabel} / {ctx.target.label} / {ctx.unavailableReason}
      </div>
    ));

    renderAgentGUINodeView({
      renderProviderUnavailableState,
      viewModel: createViewModel({
        data: {
          provider: "codex",
          agentTargetId: disabledTarget.agentTargetId,
          lastActiveAgentSessionId: null,
          conversationRailWidthPx: null
        },
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: disabledTarget.agentTargetId ?? ""
        },
        selectedAgentTarget: disabledTarget,
        agentTargets: [disabledTarget]
      })
    });

    expect(screen.getByTestId("custom-provider-unavailable")).toHaveTextContent(
      "Codex / Shared Codex / disabled by workspace policy"
    );
    expect(
      screen.queryByTestId("agent-gui-provider-readiness-gate")
    ).toBeNull();
    expect(renderProviderUnavailableState).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        providerLabel: "Codex",
        target: disabledTarget,
        unavailableReason: "disabled by workspace policy"
      })
    );
  });

  it("keeps the built-in retry gate for provider readiness unavailable", () => {
    const renderProviderUnavailableState = vi.fn(() => (
      <div data-testid="custom-provider-unavailable" />
    ));

    renderAgentGUINodeView({
      renderProviderUnavailableState,
      viewModel: createViewModel({
        providerReadinessGate: {
          status: "unavailable"
        }
      })
    });

    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("providerGateUnavailableTitle");
    expect(
      screen.queryByTestId("custom-provider-unavailable")
    ).not.toBeInTheDocument();
    expect(renderProviderUnavailableState).not.toHaveBeenCalled();
  });

  it("renders the aggregate agents checking gate when the All tab is active", () => {
    renderAgentGUINodeView({
      viewModel: createViewModel({
        conversationFilter: { kind: "all" },
        providerReadinessGate: {
          status: "checking"
        }
      })
    });

    const gate = screen.getByTestId("agent-gui-provider-readiness-gate");

    expect(gate).toHaveTextContent("providerGateCheckingTitle");
    expect(gate).toHaveTextContent("providerGateCheckingAgentsDescription");
    expect(gate.querySelector(".agent-gui-node__agent-avatar")).not.toBeNull();
    expect(
      gate.querySelector("img.agent-gui-node__empty-hero-icon-effect")
    ).toBeNull();
  });

  it("disables the gate action while an action is pending", () => {
    const onAction = vi.fn();
    renderAgentGUINodeView({
      viewModel: createViewModel({
        providerReadinessGate: {
          status: "not_installed",
          pendingAction: "install",
          onAction
        }
      })
    });

    // The pending label is shown on the action button only, not duplicated
    // as a separate standalone status line.
    expect(
      screen.queryByTestId("agent-gui-provider-readiness-gate-pending")
    ).toBeNull();

    const action = screen.getByTestId(
      "agent-gui-provider-readiness-gate-action"
    );
    expect(action).toHaveTextContent("providerGatePendingInstall");
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows the normal empty composer when no gate is present", () => {
    renderAgentGUINodeView();

    expect(
      screen.queryByTestId("agent-gui-provider-readiness-gate")
    ).toBeNull();
    expect(screen.getByTestId("agent-composer")).toBeInTheDocument();
  });

  it("does not gate existing active conversations", () => {
    const activeConversation = createConversationSummary("session-1");
    renderAgentGUINodeView({
      viewModel: createViewModel({
        activeConversation,
        activeConversationId: activeConversation.id,
        conversations: [activeConversation],
        providerReadinessGate: {
          status: "not_installed"
        }
      })
    });

    expect(
      screen.queryByTestId("agent-gui-provider-readiness-gate")
    ).toBeNull();
    expect(screen.getByTestId("agent-conversation-flow")).toBeInTheDocument();
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
  activityRuntime?: AgentActivityRuntime;
  conversationRailCollapsed?: boolean;
  conversationRailWidthPx?: number;
  isActive?: boolean;
  isAgentProviderReady?: boolean;
  onConversationRailWidthChanged?: (widthPx: number) => void;
  onLinkAction?: AgentGUINodeViewProps["onLinkAction"];
  viewModel?: AgentGUINodeViewModel | AgentGUINodeViewModelFixtureOverrides;
  actions?: AgentGUINodeViewProps["actions"];
  accountMenuState?: AgentGUINodeViewProps["accountMenuState"];
  labels?: AgentGUIViewLabels;
  onOpenConversationWindow?: AgentGUINodeViewProps["onOpenConversationWindow"];
  renderSidebarFooter?: AgentGUINodeViewProps["renderSidebarFooter"];
  renderProviderRailEmpty?: AgentGUINodeViewProps["renderProviderRailEmpty"];
  renderProviderUnavailableState?: AgentGUINodeViewProps["renderProviderUnavailableState"];
  providerRailAllPresentation?: AgentGUINodeViewProps["providerRailAllPresentation"];
  slashStatusLimits?: AgentGUINodeViewProps["slashStatusLimits"];
}

function buildAgentGUINodeViewElement({
  activityRuntime = testAgentActivityRuntime,
  conversationRailCollapsed = false,
  conversationRailWidthPx = 240,
  isActive = true,
  isAgentProviderReady = true,
  onConversationRailWidthChanged = vi.fn(),
  onLinkAction,
  viewModel = createViewModel(),
  actions = createActions(),
  accountMenuState = null,
  labels = createLabels(),
  onOpenConversationWindow,
  renderSidebarFooter,
  renderProviderRailEmpty,
  renderProviderUnavailableState,
  providerRailAllPresentation,
  slashStatusLimits = []
}: RenderAgentGUINodeViewOptions = {}) {
  const groupedViewModel = normalizeViewModelFixture(viewModel);
  return (
    <AgentActivityRuntimeProvider runtime={activityRuntime}>
      <AgentGUINodeView
        viewModel={groupedViewModel}
        renderSidebarFooter={renderSidebarFooter}
        renderProviderRailEmpty={renderProviderRailEmpty}
        renderProviderUnavailableState={renderProviderUnavailableState}
        providerRailAllPresentation={providerRailAllPresentation}
        onLinkAction={onLinkAction}
        isActive={isActive}
        isAgentProviderReady={isAgentProviderReady}
        slashStatusLimits={slashStatusLimits}
        accountMenuState={accountMenuState}
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
    </AgentActivityRuntimeProvider>
  );
}

function normalizeViewModelFixture(
  input: AgentGUINodeViewModel | AgentGUINodeViewModelFixtureOverrides
): AgentGUINodeViewModel {
  if (!("shell" in input)) {
    return createViewModel(input);
  }
  const grouped = input as AgentGUINodeViewModel;
  const mixed = input as AgentGUINodeViewModel &
    AgentGUINodeViewModelFixtureOverrides;
  const flatOverrides = { ...mixed } as Record<string, unknown>;
  for (const key of [
    "shell",
    "rail",
    "detail",
    "composer",
    "interaction",
    "readiness",
    "operations"
  ]) {
    delete flatOverrides[key];
  }
  if (Object.keys(flatOverrides).length === 0) {
    return grouped;
  }
  return groupAgentGUINodeViewModelFixture({
    ...flattenAgentGUINodeViewModelFixture(grouped),
    ...flatOverrides
  } as FlatAgentGUINodeViewModelFixture);
}

function renderAgentGUINodeView(options: RenderAgentGUINodeViewOptions = {}) {
  return render(buildAgentGUINodeViewElement(options));
}

type AgentGUINodeViewProps = Parameters<typeof AgentGUINodeView>[0];

function createNoopAgentActivityRuntime(): AgentActivityRuntime {
  const snapshot = createEmptyAgentActivitySnapshot();
  const sessionEngine = createTestAgentSessionEngine();
  return {
    promptContentUploadSupport: { file: true, image: true },
    getSessionEngine() {
      return sessionEngine;
    },
    async goalControl(input) {
      return {
        session: createRuntimeSession(input.workspaceId, input.agentSessionId),
        goal: null
      };
    },
    async createSession(input) {
      return createRuntimeSession(
        input.workspaceId,
        "session-1",
        input.cwd ?? "/workspace"
      );
    },
    async deleteSession() {
      return { removed: true };
    },
    async renameSession(input) {
      return createRuntimeSession(input.workspaceId, input.agentSessionId);
    },
    async activateSession(input) {
      return {
        session: {
          ...createRuntimeSession(
            input.workspaceId,
            input.agentSessionId,
            input.cwd ?? "/workspace"
          )
        },
        activation: { mode: input.mode, status: "attached" }
      };
    },
    async getSession(workspaceId, agentSessionId) {
      return createRuntimeSession(workspaceId, agentSessionId);
    },
    async getComposerOptions() {
      return {};
    },
    async updateSessionSettings(input) {
      return {
        agentSessionId: input.agentSessionId,
        settings: input.settings,
        session: createRuntimeSession(input.workspaceId, input.agentSessionId)
      };
    },
    getSnapshot() {
      return snapshot;
    },
    async listSessionMessages() {
      return { messages: [], latestVersion: 0, hasMore: false };
    },
    async listAgentGeneratedFiles(input) {
      return { workspaceId: input.workspaceId, entries: [] };
    },
    async load() {
      return snapshot;
    },
    ensureSessionSynchronized() {
      return () => undefined;
    },
    async sendInput(input) {
      return {
        session: createRuntimeSession(input.workspaceId, input.agentSessionId),
        turnId: "turn-1",
        turn: {
          agentSessionId: input.agentSessionId,
          phase: "submitted",
          startedAtUnixMs: 1,
          turnId: "turn-1",
          updatedAtUnixMs: 1
        },
        turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
        submitAvailability: { state: "ready" }
      };
    },
    async uploadPromptContent(input) {
      return { content: input.content };
    },
    async readSessionAttachment(input) {
      return {
        attachmentId: input.attachmentId,
        mimeType: "application/octet-stream",
        data: ""
      };
    },
    async readPromptAsset(input) {
      return {
        assetId: input.assetId ?? undefined,
        mimeType: input.mimeType,
        path: input.path ?? "",
        data: ""
      };
    },
    async setSessionPinned(input) {
      return createRuntimeSession(input.workspaceId, input.agentSessionId);
    },
    async trackSettingsProjectChange() {},
    async trackDraftComposerSettingsChange() {},
    reportDiagnostic() {},
    async unactivateSession(input) {
      return {
        agentSessionId: input.agentSessionId,
        buffered: true
      };
    },
    async submitInteractive() {
      return {
        session: createRuntimeSession("workspace-1", "session-1")
      };
    },
    subscribeSessionEvents() {
      return () => undefined;
    },
    subscribe() {
      return () => undefined;
    }
  };
}

function createRuntimeSession(
  workspaceId: string,
  agentSessionId: string,
  cwd = "/workspace",
  options: {
    agentTargetId?: string;
    provider?: "codex" | "claude-code";
  } = {}
) {
  return normalizeAgentActivitySession({
    ...{
      activeTurnId: null,
      latestTurnInteractions: [],
      pendingInteractions: []
    },
    workspaceId,
    agentSessionId,
    ...(options.agentTargetId ? { agentTargetId: options.agentTargetId } : {}),
    provider: options.provider ?? ("codex" as const),
    providerSessionId: `provider-${agentSessionId}`,
    cwd,
    title: "",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1
  });
}

function createRuntimeUserProject(project: {
  id: string;
  label: string;
  path: string;
}) {
  return {
    createdAtUnixMs: 1,
    id: project.id,
    label: project.label,
    path: project.path,
    sectionKey: `project:${project.path}`,
    updatedAtUnixMs: 1
  };
}

function createRuntimeProjectSection(input: {
  hasMore: boolean;
  nextCursor?: string;
  project: { id: string; label: string; path: string };
  sessions: ReturnType<typeof createRuntimeSession>[];
  workspaceId: string;
}): AgentActivityRuntimeSessionSection {
  return {
    kind: "project",
    sectionKey: `project:${input.project.path}`,
    userProject: createRuntimeUserProject(input.project),
    sessions: input.sessions,
    hasMore: input.hasMore,
    nextCursor: input.nextCursor
  };
}

function createRuntimeConversationsSection(input: {
  hasMore: boolean;
  nextCursor?: string;
  sessions: ReturnType<typeof createRuntimeSession>[];
}): AgentActivityRuntimeSessionSection {
  return {
    kind: "conversations",
    sectionKey: "conversations",
    sessions: input.sessions,
    hasMore: input.hasMore,
    nextCursor: input.nextCursor
  };
}

function createEmptyAgentActivitySnapshot(): AgentActivitySnapshot {
  return {
    workspaceId: "workspace-1",
    presences: [],
    sessions: [],
    sessionMessagesById: {}
  };
}

const testAgentActivityRuntime = createNoopAgentActivityRuntime();

function createActions(): AgentGUINodeViewProps["actions"] {
  return {
    updateConversationFilter: vi.fn(),
    selectConversationFilterTarget: vi.fn(),
    createConversation: vi.fn(),
    selectConversation: vi.fn(),
    submitPrompt: vi.fn(),
    goalControl: vi.fn(),
    submitGuidancePrompt: vi.fn(),
    loadOlderConversationMessages: vi.fn(),
    showPromptImagesUnsupported: vi.fn(),
    submitApprovalOption: vi.fn(),
    submitInteractivePrompt: vi.fn(),
    interruptCurrentTurn: vi.fn(),
    updateDraftContent: vi.fn(),
    updateComposerSettings: vi.fn(),
    selectHomeComposerAgentTarget: vi.fn(),
    sendQueuedPromptNext: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    editQueuedPrompt: vi.fn(),
    retryActivation: vi.fn(),
    continueInNewConversation: vi.fn(),
    toggleConversationPinned: vi.fn(),
    markConversationUnread: vi.fn(),
    removeProject: vi.fn(),
    confirmDeleteProjectConversations: vi.fn(),
    confirmDeleteConversations: vi.fn(),
    requestDeleteConversation: vi.fn(),
    cancelDeleteConversation: vi.fn(),
    confirmDeleteConversation: vi.fn(),
    renameConversation: vi.fn()
  };
}

function createViewModel(
  overrides: AgentGUINodeViewModelFixtureOverrides = {}
): AgentGUINodeViewModel {
  const flat: FlatAgentGUINodeViewModelFixture = {
    workspaceId: "room-1",
    data: {
      provider: "codex",
      lastActiveAgentSessionId: null,
      conversationRailWidthPx: null
    },
    selectedAgentTarget: createLocalAgentGUIAgentTarget("codex"),
    agentTargets: [createLocalAgentGUIAgentTarget("codex")],
    handoffAgentTargets: [createLocalAgentGUIAgentTarget("codex")],
    agentTargetsLoading: false,
    providerRailMode: "catalog",
    comingSoonProviders: [],
    conversationFilter: { kind: "all" },
    conversations: [],
    userProjects: [],
    activeConversation: null,
    activeConversationId: null,
    availableCommands: [],
    availableSkills: [],
    draftPrompt: "",
    draftContent: { prompt: "", images: [] },
    availability: "ready",
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
    goalPauseSupported: true,
    usage: null,
    backgroundAgentCount: 0,
    listError: null,
    isDeletingConversation: false,
    isDeletingProjectConversations: false,
    pendingDeleteConversation: null,
    pendingDeleteProjectConversations: null,
    pendingApproval: null,
    pendingInteractivePrompt: null,
    activeLiveState: "inactive",
    activationError: null,
    activeConversationBusy: false,
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
    inlineNotice: null,
    ...overrides,
    providerReadinessGate: overrides.providerReadinessGate ?? null
  };
  return groupAgentGUINodeViewModelFixture(flat);
}

function createActiveRenderBudgetViewModel(): AgentGUINodeViewModel {
  const activeConversation = createConversationSummary("session-1");
  const conversationDetail = createConversationDetail();
  return createViewModel({
    activeConversation,
    activeConversationId: activeConversation.id,
    conversations: [activeConversation],
    conversationDetail,
    conversation: {
      activity: conversationDetail.activity,
      workspaceRoot: "/workspace",
      sourceDetail: conversationDetail,
      rows: []
    }
  });
}

function createConversationSummary(
  id: string,
  overrides: Partial<
    AgentGUINodeViewModel["rail"]["conversations"][number]
  > = {}
): AgentGUINodeViewModel["rail"]["conversations"][number] {
  return {
    id,
    provider: "codex",
    title: id,
    status: "ready",
    cwd: "/workspace",
    updatedAtUnixMs: Date.now(),
    ...overrides
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
    session: normalizeAgentActivitySession({
      ...{
        activeTurnId: null,
        latestTurnInteractions: [],
        pendingInteractions: []
      },
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      provider: "codex",
      providerSessionId: "provider-session-1",
      cwd: "/workspace/demo",
      title: "Codex",
      activeTurn: {
        agentSessionId: "session-1",
        phase: "running",
        startedAtUnixMs: 1,
        turnId: "turn-1",
        updatedAtUnixMs: 1
      }
    }),
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

function createConversationDetailWithUserMessage(
  body: string
): WorkspaceAgentSessionDetailViewModel {
  const detail = createConversationDetail();
  return {
    ...detail,
    turns: [
      ...detail.turns,
      {
        id: "turn-2",
        userMessage: { id: "user-2", body, turnId: "turn-2" },
        userMessages: [{ id: "user-2", body, turnId: "turn-2" }],
        agentMessages: [],
        toolCalls: [],
        toolCallCount: 0,
        hasFailedToolCall: false,
        agentItems: []
      }
    ]
  };
}

function createLabels(): AgentGUIViewLabels {
  return {
    initialPlaceholder: "initialPlaceholder",
    followupPlaceholder: "followupPlaceholder",
    installRequiredPlaceholder: "installRequiredPlaceholder",
    installRequiredAction: "installRequiredAction",
    providerGateCheckingTitle: "providerGateCheckingTitle",
    providerGateCheckingDescription: "providerGateCheckingDescription",
    providerGateCheckingAgentsDescription:
      "providerGateCheckingAgentsDescription",
    providerGateInstallTitle: "providerGateInstallTitle",
    providerGateInstallDescription: "providerGateInstallDescription",
    providerGateInstallAction: "providerGateInstallAction",
    providerGateLoginTitle: "providerGateLoginTitle",
    providerGateLoginDescription: "providerGateLoginDescription",
    providerGateLoginAction: "providerGateLoginAction",
    providerGateComingSoonTitle: "providerGateComingSoonTitle",
    providerGateComingSoonDescription: "providerGateComingSoonDescription",
    providerGateComingSoonAction: "providerGateComingSoonAction",
    providerGateUnavailableTitle: "providerGateUnavailableTitle",
    providerGateUnavailableDescription: "providerGateUnavailableDescription",
    providerGateRetryAction: "providerGateRetryAction",
    providerGatePendingInstall: "providerGatePendingInstall",
    providerGatePendingLogin: "providerGatePendingLogin",
    providerGatePendingRefresh: "providerGatePendingRefresh",
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
    reasoningOptionUltra: "reasoningOptionUltra",
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
    accountMenuTitle: "Tutti Agent",
    accountMenuMember: "Member",
    accountMenuUpgrade: "Upgrade",
    accountMenuCreditsBalance: "Credits",
    accountMenuAccountCenter: "Account center",
    accountMenuSettings: "Settings",
    accountMenuFree: "Free",
    accountMenuSignIn: "Sign in",
    accountMenuSignOut: "Sign out",
    accountMenuLoading: "Loading",
    accountMenuUnavailable: "--",
    accountMenuDataUnavailable: "Some account data is unavailable",
    accountRewardToastTitle: "New user credits",
    accountRewardToastCreditsUnit: "credits",
    accountRewardToastDescription: "Added to account balance",
    accountRewardToastClose: "Close credits reward notification",
    agentConfig: "agentConfig",
    agentSettingsMenu: "agentSettingsMenu",
    agentEnvSetup: "agentEnvSetup",
    manageAgents: "manageAgents",
    manageAgentsTitle: "manageAgentsTitle",
    manageAgentsDescription: "manageAgentsDescription",
    manageAgentsAvailable: "manageAgentsAvailable",
    manageAgentsDisabled: "manageAgentsDisabled",
    manageAgentsNoAvailable: "manageAgentsNoAvailable",
    manageAgentsNoDisabled: "manageAgentsNoDisabled",
    manageAgentsKeepOneAvailable: "manageAgentsKeepOneAvailable",
    manageAgentsRunningBlocked: (agent: string) =>
      `manageAgentsRunningBlocked:${agent}`,
    removeAgentFromSidebar: (agent: string) =>
      `removeAgentFromSidebar:${agent}`,
    addAgentToSidebar: (agent: string) => `addAgentToSidebar:${agent}`,
    dragAgentToReorder: (agent: string) => `dragAgentToReorder:${agent}`,
    noConversations: "noConversations",
    emptyProjectConversations: "emptyProjectConversations",
    conversationFilterAll: "All",
    conversationFilterCodex: "Codex",
    conversationFilterClaudeCode: "Claude Code",
    conversationFilterTutti: "Tutti",
    providerSwitchLabel: "Switch provider",
    startConversation: "startConversation",
    selectConversation: "selectConversation",
    loadingConversations: "loadingConversations",
    loadingConversation: "loadingConversation",
    scrollToBottom: "scrollToBottom",
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
    conversationsSectionMoreActions: "conversationsSectionMoreActions",
    batchDeleteConversations: "batchDeleteConversations",
    batchDeleteConversationsTitle: "batchDeleteConversationsTitle",
    batchDeleteConversationsBody: (count: number) =>
      `batchDeleteConversationsBody:${count}`,
    batchDeleteConversationsConfirm: "batchDeleteConversationsConfirm",
    approvalRequired: "approvalRequired",
    approvalUnavailable: "approvalUnavailable",
    authRequired: "authRequired",
    authLogin: "authLogin",
    activatingSession: "activatingSession",
    cancellingSession: "cancellingSession",
    retryActivation: "retryActivation",
    continueInNewConversation: "continueInNewConversation",
    goalLabel: "goalLabel",
    goalTitleActive: "goalTitleActive",
    goalTitlePaused: "goalTitlePaused",
    goalTitleBlocked: "goalTitleBlocked",
    goalTitleUsageLimited: "goalTitleUsageLimited",
    goalTitleBudgetLimited: "goalTitleBudgetLimited",
    goalTitleComplete: "goalTitleComplete",
    goalBudgetUsage: (used: number, budget: number) => `${used}/${budget}`,
    goalClearHint: "goalClearHint",
    goalEditAction: "goalEditAction",
    goalPauseAction: "goalPauseAction",
    goalResumeAction: "goalResumeAction",
    goalClearAction: "goalClearAction",
    processing: "processing",
    turnSummary: "turnSummary",
    userMessageLocator: "userMessageLocator",
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
    waitingForBackgroundAgent: (count: number) =>
      `waitingForBackgroundAgent:${count}`,
    thinkingLabel: "thinkingLabel",
    toolCallsLabel: (count: number) => `toolCalls:${count}`,
    openConversationWindow: "openConversationWindow",
    showMoreConversations: "showMoreConversations",
    showLessConversations: "showLessConversations",
    deleteSession: "deleteSession",
    copySessionLink: "copySessionLink",
    renameSession: "renameSession",
    renameSessionTitle: "renameSessionTitle",
    renameSessionDescription: "renameSessionDescription",
    renameSessionPlaceholder: "renameSessionPlaceholder",
    renameSessionSave: "renameSessionSave",
    pinSession: "pinSession",
    unpinSession: "unpinSession",
    markSessionUnread: "markSessionUnread",
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
    slashPaletteCapabilitiesLoading: "slashPaletteCapabilitiesLoading",
    slashPaletteSkillsGroup: "slashPaletteSkillsGroup",
    slashPalettePluginsGroup: "slashPalettePluginsGroup",
    slashPaletteConnectorsGroup: "slashPaletteConnectorsGroup",
    slashPaletteMcpGroup: "slashPaletteMcpGroup",
    slashCommandCompactLabel: "slashCommandCompactLabel",
    slashCommandContextLabel: "slashCommandContextLabel",
    slashCommandFastLabel: "slashCommandFastLabel",
    slashCommandGoalLabel: "slashCommandGoalLabel",
    slashCommandInitLabel: "slashCommandInitLabel",
    slashCommandPlanLabel: "slashCommandPlanLabel",
    slashCommandReviewLabel: "slashCommandReviewLabel",
    slashCommandStatusLabel: "slashCommandStatusLabel",
    slashCommandUsageLabel: "slashCommandUsageLabel",
    slashCommandCompactDescription: "slashCommandCompactDescription",
    slashCommandContextDescription: "slashCommandContextDescription",
    slashCommandFastDescription: "slashCommandFastDescription",
    slashCommandGoalDescription: "slashCommandGoalDescription",
    slashCommandInitDescription: "slashCommandInitDescription",
    slashCommandPlanDescription: "slashCommandPlanDescription",
    slashCommandReviewDescription: "slashCommandReviewDescription",
    slashCommandStatusDescription: "slashCommandStatusDescription",
    slashCommandUsageDescription: "slashCommandUsageDescription",
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
    slashStatusAccount: "slashStatusAccount",
    slashStatusBaseUrl: "slashStatusBaseUrl",
    slashStatusContext: "slashStatusContext",
    slashStatusLimits: "slashStatusLimits",
    slashStatusClose: "slashStatusClose",
    slashStatusContextValue: ({ percentLeft, usedTokens, totalTokens }) =>
      `${percentLeft}:${usedTokens}:${totalTokens}`,
    slashStatusContextUnavailable: "slashStatusContextUnavailable",
    slashStatusLimitsUnavailable: "slashStatusLimitsUnavailable",
    slashStatusUsageJustUpdated: "slashStatusUsageJustUpdated",
    slashStatusUsageMinutesAgo: (count) =>
      `slashStatusUsageMinutesAgo:${count}`,
    slashStatusUsageHoursAgo: (count) => `slashStatusUsageHoursAgo:${count}`,
    slashStatusUsageUpdating: "slashStatusUsageUpdating",
    slashStatusUsageRefreshFailed: "slashStatusUsageRefreshFailed",
    slashStatusUsageRefreshAria: "slashStatusUsageRefreshAria",
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
    fileDropHint: "fileDropHint",
    mentionPalette: "mentionPalette",
    removeMention: "removeMention",
    addReference: "addReference",
    addContent: "addContent",
    referenceWorkspaceFiles: "referenceWorkspaceFiles",
    handoffConversation: "Handoff",
    handoffConversationTooltip: "Hand off to another agent",
    handoffConversationMenu: "Choose agent",
    syncPending: "syncPending",
    syncSynced: "syncSynced",
    syncFailed: "syncFailed"
  };
}

function createLabelsWithHomeSuggestions(): AgentGUIViewLabels {
  return {
    ...createLabels(),
    homeSuggestionsClose: "Close suggestions",
    homeSuggestions: [
      {
        id: "write",
        icon: "write",
        label: "Write",
        items: [{ id: "write-1", label: "Draft an announcement" }]
      },
      {
        id: "tutti-handoff",
        icon: "handoff",
        label: "Hand off to another agent",
        items: [
          {
            id: "handoff-1",
            label: "Prepare a handoff summary",
            prompt: "Write a concise handoff summary."
          }
        ]
      }
    ]
  };
}

describe("AgentGUINodeView home suggestions", () => {
  afterEach(() => {
    composerMock.calls = [];
  });

  it("keeps a category collapsed until its chip is chosen", () => {
    renderAgentGUINodeView({ labels: createLabelsWithHomeSuggestions() });

    expect(screen.queryByText("Draft an announcement")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Write" }));

    expect(screen.getByText("Draft an announcement")).toBeInTheDocument();
  });

  it("prefills the composer draft with a chosen suggestion, preserving draft images", () => {
    const updateDraftContent = vi.fn();
    const image = {
      id: "img-1",
      name: "shot.png",
      mimeType: "image/png" as const,
      previewUrl: "blob:preview"
    };

    renderAgentGUINodeView({
      actions: { ...createActions(), updateDraftContent },
      labels: createLabelsWithHomeSuggestions(),
      viewModel: createViewModel({
        draftContent: { prompt: "", images: [image] }
      })
    });

    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    fireEvent.click(screen.getByText("Draft an announcement"));

    expect(updateDraftContent).toHaveBeenCalledWith({
      prompt: "Draft an announcement",
      images: [image]
    });
  });

  it("inserts the handoff prompt text rather than its display label", () => {
    const updateDraftContent = vi.fn();

    renderAgentGUINodeView({
      actions: { ...createActions(), updateDraftContent },
      labels: createLabelsWithHomeSuggestions()
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Hand off to another agent" })
    );
    fireEvent.click(screen.getByText("Prepare a handoff summary"));

    expect(updateDraftContent).toHaveBeenCalledWith({
      prompt: "Write a concise handoff summary.",
      images: []
    });
  });

  it("does not render the suggestions section when none are provided", () => {
    const { container } = renderAgentGUINodeView({ labels: createLabels() });

    expect(
      container.querySelector(".agent-gui-node__empty-hero-suggestions")
    ).toBeNull();
  });
});
