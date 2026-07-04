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
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentSessionDetailViewModel } from "../../shared/workspaceAgentSessionDetailViewModel";
import type { AgentPromptContentBlock } from "../../shared/contracts/dto";
import type { AgentGUINodeViewModel } from "./model/agentGuiNodeTypes";
import { AgentGUINodeView, type AgentGUIViewLabels } from "./AgentGUINodeView";
import {
  createLocalAgentGUIProviderTarget,
  createLocalAgentGUIProviderTargets
} from "../../providerTargets";
import {
  AgentActivityRuntimeProvider,
  type AgentActivityRuntime,
  type AgentActivityRuntimeSessionSection,
  type AgentActivityRuntimeSessionSectionsResult
} from "../../agentActivityRuntime";
import {
  MANAGED_AGENT_ICON_URLS,
  MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS
} from "../../shared/managedAgentIcons";

const conversationFlowMock = vi.hoisted(() => ({
  calls: [] as Array<{ conversation: unknown; labels: unknown }>
}));

const conversationMetaMock = vi.hoisted(() => ({
  calls: [] as string[]
}));

const composerMock = vi.hoisted(() => ({
  calls: [] as Array<{
    backgroundAgentStatusText?: string | null;
    composerFocusRequestSequence?: number | null;
    compactSupported?: boolean | null;
    hasActiveConversation?: boolean;
    isSendingTurn?: boolean;
    onSubmit?: (
      content: AgentPromptContentBlock[],
      displayPrompt?: string
    ) => void;
    provider?: string;
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

vi.mock("./AgentSessionChrome", () => ({
  AgentSessionChrome: () => <div data-testid="agent-session-chrome" />
}));

vi.mock("./AgentComposer", () => ({
  AgentComposer: (props: {
    backgroundAgentStatusText?: string | null;
    composerFocusRequestSequence?: number | null;
    compactSupported?: boolean | null;
    hasActiveConversation?: boolean;
    isSendingTurn?: boolean;
    onSubmit?: (
      content: AgentPromptContentBlock[],
      displayPrompt?: string
    ) => void;
    provider?: string;
    showStopButton?: boolean;
    usage?: AgentGUINodeViewModel["usage"];
  }) => {
    composerMock.calls.push({
      backgroundAgentStatusText: props.backgroundAgentStatusText,
      composerFocusRequestSequence: props.composerFocusRequestSequence,
      compactSupported: props.compactSupported,
      hasActiveConversation: props.hasActiveConversation,
      isSendingTurn: props.isSendingTurn,
      provider: props.provider,
      onSubmit: props.onSubmit,
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

  it("always renders the provider filter rail", () => {
    const providerTargets = [
      createLocalAgentGUIProviderTarget("codex"),
      createLocalAgentGUIProviderTarget("claude-code")
    ];
    const { container, rerender } = renderAgentGUINodeView({
      viewModel: createViewModel({ providerTargets })
    });

    const providerRailPanel = container.querySelector(
      ".agent-gui-node__provider-rail-panel"
    );
    expect(providerRailPanel).not.toBeNull();
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
          providerTargets
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

  it("ignores rail pointer moves that do not come from the resize handle drag", () => {
    const onConversationRailWidthChanged = vi.fn();

    renderAgentGUINodeView({ onConversationRailWidthChanged });
    fireEvent.pointerMove(
      screen.getByTestId("agent-gui-conversation-rail-resize-handle"),
      { clientX: 640, pointerId: 1 }
    );

    expect(onConversationRailWidthChanged).not.toHaveBeenCalled();
  });

  it("renders the provider rail as fixed-size icon-only tiles", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-tile\s*\{[^}]*grid-template-rows:\s*32px;[^}]*gap:\s*0;[^}]*padding:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-tile\s*\+\s*\.agent-gui-node__provider-rail-tile\s*\{[^}]*margin-top:\s*12px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-avatar\s*\{[^}]*border-radius:\s*8px;/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__provider-rail-tile\[data-selected="true"\]\s+\.agent-gui-node__provider-rail-avatar\s*\{[^}]*border-radius:/s
    );
    expect(css).not.toMatch(/\.agent-gui-node__provider-rail-tile-label/);
    expect(css).not.toMatch(
      /\.agent-gui-node__provider-rail-tile\s*\{[^}]*grid-template-rows:\s*32px\s+(?:auto|28px);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-tile:disabled\s*\{[^}]*opacity:\s*0\.3;/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__provider-rail-tile\[data-disabled="true"\][^{]*\{[^}]*opacity:/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-launchpad-icon\s+\.agent-gui-node__provider-rail-launchpad-item\[data-provider-active="false"\]\s*\{[^}]*opacity:\s*0\.5;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__empty-provider-gate-action:disabled\s*\{[^}]*background:\s*var\(--fill-tertiary\);[^}]*color:\s*var\(--text-disabled\);[^}]*opacity:\s*0\.65;/s
    );
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

  it("keeps rail collapse and expand layout tracks transitionable", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__layout\s*\{[^}]*transition:\s*grid-template-columns 180ms cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header\[data-agent-gui-workbench-header-collapsed="true"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*0px\)\s+minmax\(0,\s*1fr\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-panel\s*\{[^}]*transition:\s*width 180ms cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__rail\s*\{[^}]*width:\s*var\(\s*--agent-gui-conversation-rail-content-width,\s*var\(--agent-gui-conversation-rail-width\)\s*\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__rail-panel--collapsed\s*\{[^}]*overflow:\s*hidden;[^}]*pointer-events:\s*none;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail\s*\{[^}]*width:\s*52px;[^}]*flex:\s*1\s+1\s+auto;/s
    );
    expect(css).not.toMatch(
      /data-agent-gui-workbench-header-collapsed="false"[\s\S]*?\.agent-gui-node__rail-toolbar[\s\S]*?padding-top:\s*var\(--agent-gui-workbench-header-height\);/
    );
    expect(css).toMatch(
      /\.workbench-window:has\(\[data-agent-gui-workbench-header="true"\]\)\s+\.agent-gui-node__rail-toolbar,\s*\.workbench-window:has\(\[data-agent-gui-workbench-header="true"\]\)\s+\.agent-gui-node__provider-rail-panel\s*\{[^}]*padding-top:\s*var\(--agent-gui-workbench-header-height\);/s
    );
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
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          claudeTarget
        ]
      }
    });

    fireEvent.click(screen.getByRole("tab", { name: "Claude Code" }));

    expect(actions.selectConversationFilterTarget).toHaveBeenCalledWith({
      provider: "claude-code",
      providerTargetId: claudeTarget.targetId
    });
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("keeps unavailable provider rail targets disabled and non-selectable", () => {
    const actions = createActions();
    const tuttiTarget = {
      ...createLocalAgentGUIProviderTarget("nexight"),
      disabled: true
    };
    const hermesTarget = {
      ...createLocalAgentGUIProviderTarget("hermes"),
      disabled: true
    };
    const openclawTarget = {
      ...createLocalAgentGUIProviderTarget("openclaw"),
      disabled: true
    };
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          createLocalAgentGUIProviderTarget("claude-code"),
          tuttiTarget,
          hermesTarget,
          openclawTarget
        ]
      }
    });

    const tuttiTile = screen.getByRole("tab", { name: "Tutti" });
    const hermesTile = screen.getByRole("tab", { name: "Hermes" });
    const openclawTile = screen.getByRole("tab", { name: "OpenClaw" });

    expect(tuttiTile).toHaveAttribute("data-disabled", "true");
    expect(hermesTile).toHaveAttribute("data-disabled", "true");
    expect(openclawTile).toHaveAttribute("data-disabled", "true");
    expect(tuttiTile).toBeDisabled();
    expect(hermesTile).toBeDisabled();
    expect(openclawTile).toBeDisabled();

    fireEvent.click(tuttiTile);
    fireEvent.click(hermesTile);
    fireEvent.click(openclawTile);

    expect(actions.selectConversationFilterTarget).not.toHaveBeenCalled();
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("orders provider rail tiles as Codex, Claude Code, Tutti, Hermes, OpenClaw without visible provider labels", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        providerTargets: [
          {
            ...createLocalAgentGUIProviderTarget("nexight"),
            disabled: true
          },
          createLocalAgentGUIProviderTarget("claude-code"),
          {
            ...createLocalAgentGUIProviderTarget("hermes"),
            disabled: true
          },
          createLocalAgentGUIProviderTarget("codex")
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
    ).toEqual(["All", "Codex", "Claude Code", "Tutti", "Hermes", "OpenClaw"]);
    expect(screen.getByRole("tab", { name: "All" })).toHaveTextContent("");
    expect(screen.getByRole("tab", { name: "Codex" })).toHaveTextContent("");
    expect(screen.getByRole("tab", { name: "Claude Code" })).toHaveTextContent(
      ""
    );
    expect(screen.getByRole("tab", { name: "Tutti" })).toHaveTextContent("");
    expect(screen.getByRole("tab", { name: "Hermes" })).toHaveTextContent("");
    expect(screen.getByRole("tab", { name: "OpenClaw" })).toHaveTextContent("");

    expect(
      screen
        .getByRole("tab", { name: "Claude Code" })
        .querySelector("img")
        ?.getAttribute("src")
    ).toBe(MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS["claude-code"]);
    expect(
      screen
        .getByRole("tab", { name: "Tutti" })
        .querySelector("img")
        ?.getAttribute("src")
    ).toBe(MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.tutti);
  });

  it("shows provider names in tooltips for unlabeled provider rail icons", async () => {
    const source = readFileSync(
      resolve("agent-gui/agentGuiNode/AgentGUINodeView.tsx"),
      "utf8"
    );
    expect(source).toMatch(
      /<TooltipContent\s+side="right"\s+sideOffset=\{-4\}>/
    );

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          createLocalAgentGUIProviderTarget("claude-code")
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
    const codexTarget = createLocalAgentGUIProviderTarget("codex");
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: claudeTarget.agentTargetId ?? ""
        },
        selectedProviderTarget: claudeTarget,
        providerTargets: [codexTarget, claudeTarget]
      }
    });

    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));

    expect(actions.selectConversationFilterTarget).toHaveBeenCalledWith({
      provider: "codex",
      providerTargetId: codexTarget.targetId
    });
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("highlights All from the conversation filter without constraining target", () => {
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        selectedProviderTarget: claudeTarget,
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          claudeTarget
        ]
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
    const codexTarget = createLocalAgentGUIProviderTarget("codex");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: codexTarget.agentTargetId ?? ""
        },
        selectedProviderTarget: codexTarget,
        providerTargets: [
          codexTarget,
          createLocalAgentGUIProviderTarget("claude-code")
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
        selectedProviderTarget: createLocalAgentGUIProviderTarget("codex"),
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          createLocalAgentGUIProviderTarget("claude-code")
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

  it("renders the All tile launchpad icons in provider rail order", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        providerTargets: [
          createLocalAgentGUIProviderTarget("claude-code"),
          createLocalAgentGUIProviderTarget("codex")
        ]
      }
    });

    const allTile = screen.getByRole("tab", { name: "All" });
    const launchpadItems = Array.from(
      allTile.querySelectorAll(".agent-gui-node__provider-rail-launchpad-item")
    );
    expect(
      launchpadItems.map((item) =>
        item.querySelector("img")?.getAttribute("src")
      )
    ).toEqual([
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.codex,
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS["claude-code"],
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.tutti,
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.hermes
    ]);
  });

  it("keeps the selected All tile as a launchpad grid", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        providerTargets: [
          createLocalAgentGUIProviderTarget("claude-code"),
          createLocalAgentGUIProviderTarget("codex")
        ]
      }
    });

    const allTile = screen.getByRole("tab", { name: "All" });
    const launchpadIcon = allTile.querySelector(
      ".agent-gui-node__provider-rail-launchpad-icon"
    );
    expect(launchpadIcon).not.toBeNull();
    expect(launchpadIcon).not.toHaveAttribute("data-scrollable");
    expect(launchpadIcon?.children).toHaveLength(4);
  });

  it("renders the empty hero icon area with the All tile launchpad grid", () => {
    const { container } = renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        providerTargets: [
          createLocalAgentGUIProviderTarget("claude-code"),
          createLocalAgentGUIProviderTarget("codex")
        ]
      }
    });

    const heroIconGrid = container.querySelector(
      ".agent-gui-node__empty-hero-launchpad-icon .agent-gui-node__provider-rail-launchpad-icon"
    );
    expect(heroIconGrid).not.toBeNull();
    expect(heroIconGrid?.children).toHaveLength(4);
    expect(
      Array.from(
        heroIconGrid?.querySelectorAll(
          ".agent-gui-node__provider-rail-launchpad-item"
        ) ?? []
      ).map((item) => item.querySelector("img")?.getAttribute("src"))
    ).toEqual([
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.codex,
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS["claude-code"],
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.tutti,
      MANAGED_AGENT_PROVIDER_RAIL_ICON_URLS.hermes
    ]);
    expect(
      Array.from(
        heroIconGrid?.querySelectorAll(
          ".agent-gui-node__provider-rail-launchpad-item"
        ) ?? []
      ).map((item) => item.getAttribute("data-provider-active"))
    ).toEqual(["true", "false", "false", "false"]);
  });

  it("remounts the empty hero icon when switching provider targets", () => {
    const codexTarget = createLocalAgentGUIProviderTarget("codex");
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    const { container, rerender } = renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: {
          kind: "agentTarget",
          agentTargetId: codexTarget.agentTargetId ?? ""
        },
        selectedProviderTarget: codexTarget,
        providerTargets: [codexTarget, claudeTarget]
      }
    });

    const initialIcon = container.querySelector<HTMLImageElement>(
      ".agent-gui-node__empty-hero-icon-effect"
    );
    expect(initialIcon).not.toBeNull();
    expect(initialIcon?.getAttribute("src")).toBe(
      MANAGED_AGENT_ICON_URLS.codex
    );

    rerender(
      buildAgentGUINodeViewElement({
        viewModel: createViewModel({
          conversationFilter: {
            kind: "agentTarget",
            agentTargetId: claudeTarget.agentTargetId ?? ""
          },
          selectedProviderTarget: claudeTarget,
          providerTargets: [codexTarget, claudeTarget]
        })
      })
    );

    const nextIcon = container.querySelector<HTMLImageElement>(
      ".agent-gui-node__empty-hero-icon-effect"
    );
    expect(nextIcon).not.toBeNull();
    expect(nextIcon).not.toBe(initialIcon);
    expect(nextIcon?.getAttribute("src")).toBe(
      MANAGED_AGENT_ICON_URLS["claude-code"]
    );
  });

  it("dims disabled provider options in the empty hero provider select", async () => {
    const actions = createActions();
    const disabledTuttiTarget = {
      ...createLocalAgentGUIProviderTarget("nexight"),
      disabled: true
    };
    const disabledHermesTarget = {
      ...createLocalAgentGUIProviderTarget("hermes"),
      disabled: true
    };
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        selectedProviderTarget: createLocalAgentGUIProviderTarget("codex"),
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          createLocalAgentGUIProviderTarget("claude-code"),
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
        handoffConversationMenu: "Choose agent"
      }
    });

    ensurePointerCaptureApi();

    const providerSelect = screen.getByRole("combobox", {
      name: "Switch provider"
    });
    fireEvent.keyDown(providerSelect, { key: "ArrowDown" });

    const tuttiOption = await screen.findByRole("option", {
      name: "Tutti Agent"
    });
    const hermesOption = screen.getByRole("option", { name: "Hermes" });

    expect(tuttiOption).toHaveAttribute("data-disabled");
    expect(tuttiOption).toHaveClass("opacity-30");
    expect(tuttiOption.querySelector("img")).toHaveClass("grayscale");
    expect(hermesOption).toHaveAttribute("data-disabled");
    expect(hermesOption).toHaveClass("opacity-30");

    fireEvent.click(tuttiOption);

    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("selects the All tile for daemon local Codex targets", () => {
    const daemonCodexTarget = {
      ...createLocalAgentGUIProviderTarget("codex"),
      targetId: "local-codex"
    };

    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        selectedProviderTarget: daemonCodexTarget,
        providerTargets: [
          daemonCodexTarget,
          {
            ...createLocalAgentGUIProviderTarget("claude-code"),
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
        providerTargets: [],
        providerTargetsLoading: true
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
        providerTargets: [],
        providerTargetsLoading: false
      }
    });

    expect(screen.getByRole("tablist")).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("tab", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Codex" })).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Claude Code" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tutti" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Hermes" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "OpenClaw" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tutti" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Hermes" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "OpenClaw" })).toBeDisabled();
    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    ).toEqual(["All", "Codex", "Claude Code", "Tutti", "Hermes", "OpenClaw"]);
  });

  it("keeps the provider rail to the default agent tiles for static provider catalogs", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        providerTargets: createLocalAgentGUIProviderTargets(),
        providerTargetsLoading: false
      }
    });

    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    ).toEqual(["All", "Codex", "Claude Code", "Tutti", "Hermes", "OpenClaw"]);
  });

  it("falls back to All for avatar rail targets without an agent target id", () => {
    const actions = createActions();
    const localGeminiTarget = {
      ...createLocalAgentGUIProviderTarget("gemini"),
      label: "Local Gemini"
    };
    const sharedGeminiTarget = {
      ...createLocalAgentGUIProviderTarget("gemini"),
      targetId: "shared-agent:gemini-1",
      label: "Shared Gemini"
    };
    renderAgentGUINodeView({
      actions,
      viewModel: {
        ...createViewModel(),
        conversationFilter: { kind: "all" },
        selectedProviderTarget: sharedGeminiTarget,
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          localGeminiTarget,
          sharedGeminiTarget
        ]
      }
    });

    const sharedTile = screen.getByRole("tab", { name: "Shared Gemini" });
    expect(sharedTile).toHaveAttribute("aria-selected", "false");

    fireEvent.click(sharedTile);

    expect(actions.selectConversationFilterTarget).toHaveBeenCalledWith({
      provider: "gemini",
      providerTargetId: "shared-agent:gemini-1"
    });
    expect(actions.updateConversationFilter).not.toHaveBeenCalled();
    expect(actions.selectHomeComposerAgentTarget).not.toHaveBeenCalled();
  });

  it("passes provider switching options into the multi-provider composer", () => {
    const actions = createActions();
    const providerTargets = [
      createLocalAgentGUIProviderTarget("codex"),
      createLocalAgentGUIProviderTarget("claude-code")
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
        providerTargets
      }
    });

    const trigger = screen.getByRole("combobox", { name: "Switch provider" });

    expect(trigger).toHaveClass("agent-gui-node__empty-hero-provider-select");
    expect(trigger).toHaveTextContent("Codex");
  });

  it("renders provider switching options in the localized title", () => {
    const providerTargets = [
      createLocalAgentGUIProviderTarget("codex"),
      createLocalAgentGUIProviderTarget("claude-code")
    ];
    renderAgentGUINodeView({
      labels: {
        ...createLabels(),
        empty: "需要 Codex 帮你做些什么？",
        emptyProvider: "Codex",
        providerSwitchLabel: "切换 Provider",
        handoffConversation: "Handoff",
        handoffConversationMenu: "选择 Agent"
      },
      viewModel: {
        ...createViewModel(),
        providerTargets
      }
    });

    const trigger = screen.getByRole("combobox", { name: "切换 Provider" });

    expect(trigger).toHaveClass("agent-gui-node__empty-hero-provider-select");
    expect(trigger).toHaveTextContent("Codex");
  });

  it("renders the composer from the selected provider target", () => {
    const providerTargets = [
      createLocalAgentGUIProviderTarget("codex"),
      createLocalAgentGUIProviderTarget("claude-code")
    ];
    const selectedProviderTarget =
      createLocalAgentGUIProviderTarget("claude-code");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        data: {
          provider: "codex",
          agentTargetId: "local:codex",
          lastActiveAgentSessionId: null,
          conversationRailWidthPx: null
        },
        providerTargets,
        selectedProviderTarget
      }
    });

    expect(composerMock.calls.at(-1)).toMatchObject({
      provider: "claude-code"
    });
  });

  it("hides provider switching in the title for an active session", () => {
    const providerTargets = [
      createLocalAgentGUIProviderTarget("codex"),
      createLocalAgentGUIProviderTarget("claude-code")
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
        providerTargets
      }
    });

    expect(
      screen.queryByRole("combobox", { name: "Switch provider" })
    ).not.toBeInTheDocument();
  });

  it("tells the composer whether there is an active conversation, so it knows when to defer clearing the draft on submit (Feishu UUl2Oc)", () => {
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation: null,
        activeConversationId: null
      }
    });

    expect(composerMock.calls.at(-1)).toMatchObject({
      hasActiveConversation: false
    });

    const conversation = createConversationSummary("session-1");
    renderAgentGUINodeView({
      viewModel: {
        ...createViewModel(),
        activeConversation: conversation,
        activeConversationId: conversation.id,
        conversations: [conversation]
      }
    });

    expect(composerMock.calls.at(-1)).toMatchObject({
      hasActiveConversation: true
    });
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

  it("does not render cwd-derived project sections while runtime sections are loading", () => {
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

    expect(
      screen.getByTestId("agent-gui-conversation-list-loading-skeleton")
    ).toHaveAccessibleName("loadingConversations");
    expect(screen.queryByRole("button", { name: /App/u })).toBeNull();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-project-session-1")
    ).not.toBeInTheDocument();
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
    const viewModel = {
      ...baseViewModel,
      data: {
        ...baseViewModel.data,
        provider: "claude-code" as const
      },
      selectedProviderTarget: createLocalAgentGUIProviderTarget("claude-code"),
      conversations: [initialConversation]
    };
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
            ...viewModel.data,
            provider: "codex" as const
          },
          selectedProviderTarget: createLocalAgentGUIProviderTarget("codex"),
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

  it("passes the active agent target filter to runtime rail section requests", async () => {
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
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
        selectedProviderTarget: claudeTarget,
        providerTargets: [
          createLocalAgentGUIProviderTarget("codex"),
          claudeTarget
        ],
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
      viewModel: createViewModel({
        providerReadinessGate: {
          status: "not_installed",
          onAction
        }
      })
    });

    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("providerGateInstallTitle");
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
      viewModel: createViewModel({
        providerReadinessGate: {
          status: "auth_required",
          onAction
        }
      })
    });

    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate")
    ).toHaveTextContent("providerGateLoginTitle");

    const action = screen.getByTestId(
      "agent-gui-provider-readiness-gate-action"
    );
    expect(action).toHaveTextContent("providerGateLoginAction");
    expect(action.querySelector("svg")).toBeNull();

    fireEvent.click(action);

    expect(onAction).toHaveBeenCalledWith("codex", "login");
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
    expect(
      gate.querySelector(".agent-gui-node__empty-hero-launchpad-icon")
    ).not.toBeNull();
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

    expect(
      screen.getByTestId("agent-gui-provider-readiness-gate-pending")
    ).toHaveTextContent("providerGatePendingInstall");

    const action = screen.getByTestId(
      "agent-gui-provider-readiness-gate-action"
    );
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
  viewModel?: AgentGUINodeViewModel;
  actions?: AgentGUINodeViewProps["actions"];
  labels?: AgentGUIViewLabels;
  onOpenConversationWindow?: AgentGUINodeViewProps["onOpenConversationWindow"];
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
  labels = createLabels(),
  onOpenConversationWindow,
  slashStatusLimits = []
}: RenderAgentGUINodeViewOptions = {}) {
  return (
    <AgentActivityRuntimeProvider runtime={activityRuntime}>
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
    </AgentActivityRuntimeProvider>
  );
}

function renderAgentGUINodeView(options: RenderAgentGUINodeViewOptions = {}) {
  return render(buildAgentGUINodeViewElement(options));
}

type AgentGUINodeViewProps = Parameters<typeof AgentGUINodeView>[0];

function createNoopAgentActivityRuntime(): AgentActivityRuntime {
  const snapshot = createEmptyAgentActivitySnapshot();
  return {
    promptContentUploadSupport: { file: true, image: true },
    async goalControl(input) {
      return {
        session: createRuntimeSession(input.workspaceId, input.agentSessionId),
        goal: null
      };
    },
    async cancelSession(input) {
      return {
        session: createRuntimeSession(input.workspaceId, input.agentSessionId),
        canceled: false,
        reason: "no_active_turn"
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
    async activateSession(input) {
      return {
        session: createRuntimeSession(
          input.workspaceId,
          input.agentSessionId,
          input.cwd ?? "/workspace"
        ),
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
        settings: input.settings
      };
    },
    async warmupOpenclawGateway() {
      return { accepted: true, ready: true };
    },
    async getSessionControlState() {
      return { status: "ready" } as Awaited<
        ReturnType<AgentActivityRuntime["getSessionControlState"]>
      >;
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
    retainSessionEvents() {
      return () => undefined;
    },
    async sendInput(input) {
      return {
        session: createRuntimeSession(input.workspaceId, input.agentSessionId),
        turnId: "turn-1",
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
      return {};
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
  return {
    workspaceId,
    agentSessionId,
    ...(options.agentTargetId ? { agentTargetId: options.agentTargetId } : {}),
    provider: options.provider ?? ("codex" as const),
    providerSessionId: `provider-${agentSessionId}`,
    cwd,
    title: "",
    status: "ready",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1
  };
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
    retryOpenclawGateway: vi.fn(),
    toggleConversationPinned: vi.fn(),
    removeProject: vi.fn(),
    confirmDeleteProjectConversations: vi.fn(),
    confirmDeleteConversations: vi.fn(),
    requestDeleteConversation: vi.fn(),
    cancelDeleteConversation: vi.fn(),
    confirmDeleteConversation: vi.fn()
  };
}

function createViewModel(
  overrides: Partial<AgentGUINodeViewModel> = {}
): AgentGUINodeViewModel {
  return {
    workspaceId: "room-1",
    data: {
      provider: "codex",
      lastActiveAgentSessionId: null,
      conversationRailWidthPx: null
    },
    selectedProviderTarget: createLocalAgentGUIProviderTarget("codex"),
    providerTargets: [createLocalAgentGUIProviderTarget("codex")],
    providerTargetsLoading: false,
    conversationFilter: { kind: "all" },
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
    inlineNotice: null,
    ...overrides,
    providerReadinessGate: overrides.providerReadinessGate ?? null
  };
}

function createConversationSummary(
  id: string,
  overrides: Partial<AgentGUINodeViewModel["conversations"][number]> = {}
): AgentGUINodeViewModel["conversations"][number] {
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
    mentionPalette: "mentionPalette",
    removeMention: "removeMention",
    addReference: "addReference",
    addContent: "addContent",
    referenceWorkspaceFiles: "referenceWorkspaceFiles",
    handoffConversation: "Handoff",
    handoffConversationMenu: "Choose agent",
    syncPending: "syncPending",
    syncSynced: "syncSynced",
    syncFailed: "syncFailed"
  };
}
