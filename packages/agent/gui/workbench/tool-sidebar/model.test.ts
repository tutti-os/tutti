import { describe, expect, it } from "vitest";
import {
  agentToolPanelDefaultWidthById,
  clampAgentToolPanelWidth,
  createAgentToolSidebarState,
  filterAgentToolAddablePanels,
  filterAgentToolPanels,
  reduceAgentToolSidebarState,
  resolveAgentToolPanelExpansionTransfer,
  shouldAutoCollapseAgentToolSidebar,
  type AgentToolPanelDefinition
} from "./model.ts";

const panels: readonly AgentToolPanelDefinition[] = [
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" }
];

describe("agent tool sidebar model", () => {
  it("uses the shared 720px default for task and message panels", () => {
    expect(agentToolPanelDefaultWidthById.tasks).toBe(720);
    expect(agentToolPanelDefaultWidthById.messages).toBe(720);
  });

  it("preserves the established Side width bounds in the shared sidebar", () => {
    expect(agentToolPanelDefaultWidthById.side).toBe(440);
    expect(
      clampAgentToolPanelWidth({
        mainContentMinWidth: 280,
        panel: "side",
        viewportWidth: 1_400,
        width: 100
      })
    ).toBe(360);
    expect(
      clampAgentToolPanelWidth({
        mainContentMinWidth: 280,
        panel: "side",
        viewportWidth: 1_400,
        width: 900
      })
    ).toBe(600);
  });

  it("keeps only unique supported panels in host order", () => {
    expect(
      filterAgentToolPanels([
        ...panels,
        { id: "files", label: "Duplicate" },
        { id: "unsupported", label: "Unsupported" }
      ])
    ).toEqual(panels);
  });

  it("preserves host-owned panel creation policy", () => {
    const contextual = { canAdd: false, id: "side", label: "Side" } as const;
    expect(filterAgentToolPanels([contextual])).toEqual([contextual]);
    expect(filterAgentToolAddablePanels([...panels, contextual])).toEqual(
      panels
    );
  });

  it("reuses the latest panel tab and returns to the previous tab when closing", () => {
    let state = createAgentToolSidebarState();
    state = reduceAgentToolSidebarState(state, {
      panel: "files",
      tabId: "files:first",
      type: "add-panel"
    });
    state = reduceAgentToolSidebarState(state, {
      panel: "terminal",
      tabId: "terminal:first",
      type: "add-panel"
    });
    state = reduceAgentToolSidebarState(state, {
      panel: "files",
      tabId: "files:ignored",
      type: "open-panel"
    });

    expect(state.activeTabId).toBe("files:first");
    expect(state.mountedTabs).toHaveLength(2);

    state = reduceAgentToolSidebarState(state, {
      tabId: "files:first",
      type: "close-tab"
    });
    expect(state.activePanel).toBe("terminal");
    expect(state.activeTabId).toBe("terminal:first");

    state = reduceAgentToolSidebarState(state, {
      tabId: "terminal:first",
      type: "close-tab"
    });
    expect(state.activePanel).toBeNull();
    expect(state.activeTabId).toBeNull();
    expect(state.mountedTabs).toEqual([]);
  });

  it("clamps panel width to the panel and remaining-content bounds", () => {
    expect(
      clampAgentToolPanelWidth({
        mainContentMinWidth: 280,
        panel: "files",
        viewportWidth: 900,
        width: 900
      })
    ).toBe(620);
  });

  it("collapses a sidebar only after it crosses the main-content boundary", () => {
    expect(
      shouldAutoCollapseAgentToolSidebar({
        containerWidth: 1470,
        mainContentMinWidth: 750,
        sidebarWidth: 720
      })
    ).toBe(false);
    expect(
      shouldAutoCollapseAgentToolSidebar({
        containerWidth: 1469,
        mainContentMinWidth: 750,
        sidebarWidth: 720
      })
    ).toBe(true);
  });

  it("ensures a background panel without changing the active tab", () => {
    let state = createAgentToolSidebarState({
      activePanel: "files",
      activeTabId: "files:first",
      mountedTabs: [{ id: "files:first", panel: "files" }]
    });
    state = reduceAgentToolSidebarState(state, {
      panel: "browser",
      resourceId: "agent-1",
      tabId: "browser:agent-1",
      type: "ensure-panel"
    });

    expect(state.activePanel).toBe("files");
    expect(state.activeTabId).toBe("files:first");
    expect(state.mountedTabs).toContainEqual({
      id: "browser:agent-1",
      panel: "browser",
      resourceId: "agent-1"
    });

    const repeated = reduceAgentToolSidebarState(state, {
      panel: "browser",
      resourceId: "agent-1",
      tabId: "browser:duplicate",
      type: "ensure-panel"
    });
    expect(repeated).toBe(state);
  });

  it("transfers expansion while remembering both panel widths", () => {
    expect(
      resolveAgentToolPanelExpansionTransfer({
        expandedPanel: "files",
        nextPanel: "browser",
        nextPanelWidth: 640,
        widthBeforeExpansion: 560
      })
    ).toEqual({
      expandedPanel: "browser",
      nextPanelWidthBeforeExpansion: 640,
      previousPanel: "files",
      previousPanelWidth: 560
    });
  });
});
