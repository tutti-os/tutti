import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGUIAgentTarget } from "../../../types";
import {
  AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY,
  parseAgentGUIProviderRailPreferences
} from "../model/agentGuiProviderRailOrder";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIProviderRail } from "./AgentGUIProviderRail";

describe("AgentGUIProviderRail selection", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("derives mutually exclusive aria and visual selection only from conversationFilter", () => {
    const readyTarget = target({
      agentTargetId: "agent:ready",
      label: "Ready Agent",
      provider: "ready-provider",
      targetId: "legacy:ready"
    });
    const unavailableTarget = target({
      agentTargetId: "agent:offline",
      availability: { status: "unavailable" },
      disabled: true,
      label: "Offline Agent",
      provider: "offline-provider",
      targetId: "legacy:offline"
    });
    const placeholderTarget = target({
      agentTargetId: "agent:placeholder",
      disabled: true,
      label: "Placeholder Agent",
      provider: "placeholder-provider",
      targetId: "local:placeholder-provider"
    });
    const props = providerRailProps({
      agentTargets: [readyTarget, unavailableTarget, placeholderTarget],
      conversationFilter: {
        kind: "agentTarget",
        agentTargetId: "agent:offline"
      },
      selectedAgentTarget: placeholderTarget
    });
    const view = render(providerRail(props));

    expectOnlySelectedTab("Offline Agent");

    view.rerender(
      providerRail({
        ...props,
        conversationFilter: { kind: "all" },
        selectedAgentTarget: unavailableTarget
      })
    );

    expectOnlySelectedTab("All agents");

    view.rerender(
      providerRail({
        ...props,
        conversationFilter: {
          kind: "agentTarget" as const,
          agentTargetId: "agent:placeholder"
        },
        selectedAgentTarget: readyTarget
      })
    );

    expectOnlySelectedTab("Placeholder Agent");
  });

  it("uses canonical agentTargetId for tile clicks and fails closed without it", () => {
    const onSelectConversationFilterTarget = vi.fn();
    const canonicalTarget = target({
      agentTargetId: "  agent:canonical  ",
      disabled: true,
      label: "Canonical Agent",
      provider: "canonical-provider",
      targetId: "legacy-provider-target"
    });
    const compatibilityTarget = target({
      label: "Compatibility Agent",
      provider: "compatibility-provider",
      targetId: "legacy-only-target"
    });
    render(
      providerRail(
        providerRailProps({
          agentTargets: [canonicalTarget, compatibilityTarget],
          onSelectConversationFilterTarget
        })
      )
    );

    fireEvent.click(screen.getByRole("tab", { name: "Canonical Agent" }));

    expect(onSelectConversationFilterTarget).toHaveBeenCalledTimes(1);
    expect(onSelectConversationFilterTarget).toHaveBeenLastCalledWith({
      provider: "canonical-provider",
      agentTargetId: "agent:canonical"
    });

    fireEvent.click(screen.getByRole("tab", { name: "Compatibility Agent" }));

    expect(onSelectConversationFilterTarget).toHaveBeenCalledTimes(1);
  });

  it("keeps All clicks aggregate and uses canonical identity for manager fallback", () => {
    const onSelectConversationFilterTarget = vi.fn();
    const onSelectHomeComposerAgentTarget = vi.fn();
    const onUpdateConversationFilter = vi.fn();
    const selectedTarget = target({
      agentTargetId: "agent:selected",
      disabled: true,
      label: "Selected Agent",
      provider: "selected-provider",
      targetId: "legacy:selected"
    });
    const fallbackTarget = target({
      agentTargetId: "agent:fallback",
      label: "Fallback Agent",
      provider: "fallback-provider",
      targetId: "legacy:fallback"
    });
    const props = providerRailProps({
      agentTargets: [selectedTarget, fallbackTarget],
      conversationFilter: { kind: "all" },
      onSelectConversationFilterTarget,
      onSelectHomeComposerAgentTarget,
      onUpdateConversationFilter,
      selectedAgentTarget: selectedTarget
    });
    const view = render(providerRail(props));

    fireEvent.click(screen.getByRole("tab", { name: "All agents" }));

    expect(onUpdateConversationFilter).toHaveBeenLastCalledWith({
      kind: "all"
    });
    expect(onSelectConversationFilterTarget).not.toHaveBeenCalled();

    view.rerender(
      providerRail({
        ...props,
        conversationFilter: {
          kind: "agentTarget" as const,
          agentTargetId: "agent:selected"
        },
        managerOpen: true
      })
    );
    fireEvent.contextMenu(
      screen.getByRole("listitem", { name: "Reorder Selected Agent" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Selected Agent" })
    );

    expect(onSelectHomeComposerAgentTarget).toHaveBeenCalledWith({
      provider: "fallback-provider",
      agentTargetId: "agent:fallback"
    });
    expect(onUpdateConversationFilter).toHaveBeenLastCalledWith({
      kind: "all"
    });
  });

  it("resolves rail container drop targets from provider tile identities", () => {
    const codex = target({
      agentTargetId: "agent:codex",
      label: "Codex",
      provider: "codex",
      targetId: "local:codex"
    });
    const claude = target({
      agentTargetId: "agent:claude",
      label: "Claude",
      provider: "claude-code",
      targetId: "local:claude"
    });
    const cursor = target({
      agentTargetId: "agent:cursor",
      label: "Cursor",
      provider: "cursor",
      targetId: "local:cursor"
    });
    render(
      providerRail(providerRailProps({ agentTargets: [codex, claude, cursor] }))
    );
    const codexTile = screen.getByRole("tab", { name: "Codex" });
    const claudeTile = screen.getByRole("tab", { name: "Claude" });
    const cursorTile = screen.getByRole("tab", { name: "Cursor" });
    mockVerticalBounds(codexTile, 0);
    mockVerticalBounds(claudeTile, 40);
    mockVerticalBounds(cursorTile, 80);
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(cursorTile, { dataTransfer });
    const tablist = screen.getByRole("tablist");
    const dragOverEvent = createEvent.dragOver(tablist, { dataTransfer });
    Object.defineProperty(dragOverEvent, "clientY", { value: 5 });
    fireEvent(tablist, dragOverEvent);

    expect(codexTile).toHaveAttribute("data-drag-over", "before");

    const dropEvent = createEvent.drop(tablist, { dataTransfer });
    Object.defineProperty(dropEvent, "clientY", { value: 5 });
    fireEvent(tablist, dropEvent);

    expect(
      parseAgentGUIProviderRailPreferences(
        globalThis.localStorage.getItem(
          AGENT_GUI_PROVIDER_RAIL_PREFERENCES_STORAGE_KEY
        )
      ).order
    ).toEqual(["local:cursor", "local:codex", "local:claude"]);
    expect(
      screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))
    ).toEqual(["All agents", "Cursor", "Codex", "Claude"]);
  });
});

function mockVerticalBounds(element: HTMLElement, top: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    bottom: top + 32,
    height: 32,
    left: 0,
    right: 52,
    toJSON: () => ({}),
    top,
    width: 52,
    x: 0,
    y: top
  });
}

function createDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "uninitialized",
    getData: (format: string) => values.get(format) ?? "",
    setData: (format: string, value: string) => {
      values.set(format, value);
    }
  } as unknown as DataTransfer;
}

function expectOnlySelectedTab(name: string): void {
  const tabs = screen.getAllByRole("tab");
  const selectedTabs = tabs.filter(
    (tab) => tab.getAttribute("aria-selected") === "true"
  );
  expect(selectedTabs).toHaveLength(1);
  expect(selectedTabs[0]).toBe(screen.getByRole("tab", { name }));
  for (const tab of tabs) {
    const selected = tab === selectedTabs[0];
    expect(tab).toHaveAttribute("aria-selected", selected ? "true" : "false");
    expect(tab).toHaveAttribute("data-selected", selected ? "true" : "false");
  }
}

function target(
  input: Pick<AgentGUIAgentTarget, "label" | "provider" | "targetId"> &
    Partial<AgentGUIAgentTarget>
): AgentGUIAgentTarget {
  return {
    ref: { kind: "local", provider: input.provider },
    ...input
  };
}

function providerRailProps(
  overrides: Partial<React.ComponentProps<typeof AgentGUIProviderRail>> = {}
): React.ComponentProps<typeof AgentGUIProviderRail> {
  return {
    activeConversation: null,
    activeConversationId: null,
    agentTargets: [],
    agentTargetsLoading: false,
    comingSoonProviders: [],
    conversationFilter: { kind: "all" },
    conversations: [],
    labels: LABELS,
    managerOpen: false,
    onManagerOpenChange: vi.fn(),
    onRequestComposerFocus: vi.fn(),
    onSelectConversationFilterTarget: vi.fn(),
    onSelectHomeComposerAgentTarget: vi.fn(),
    onUpdateConversationFilter: vi.fn(),
    providerRailMode: "exact",
    selectedAgentTarget: target({
      agentTargetId: "agent:default",
      label: "Default Agent",
      provider: "default-provider",
      targetId: "legacy:default"
    }),
    ...overrides
  };
}

function providerRail(
  props: React.ComponentProps<typeof AgentGUIProviderRail>
): React.ReactElement {
  return (
    <TooltipProvider>
      <AgentGUIProviderRail {...props} />
    </TooltipProvider>
  );
}

const LABELS = {
  addAgentToSidebar: (agent: string) => `Add ${agent}`,
  conversationFilterAll: "All agents",
  dragAgentToReorder: (agent: string) => `Reorder ${agent}`,
  manageAgentsAvailable: "Available",
  manageAgentsDescription: "Manage rail agents",
  manageAgentsDisabled: "Hidden",
  manageAgentsKeepOneAvailable: "Keep one available",
  manageAgentsNoAvailable: "No available agents",
  manageAgentsNoDisabled: "No hidden agents",
  manageAgentsRunningBlocked: (agent: string) => `Cannot remove ${agent}`,
  manageAgentsTitle: "Manage agents",
  providerSwitchLabel: "Agent filters",
  removeAgentFromSidebar: (agent: string) => `Remove ${agent}`
} as AgentGUIViewLabels;
