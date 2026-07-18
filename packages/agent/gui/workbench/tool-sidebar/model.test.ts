import { describe, expect, it } from "vitest";
import {
  clampAgentToolPanelWidth,
  createAgentToolSidebarState,
  filterAgentToolPanels,
  reduceAgentToolSidebarState,
  resolveAgentToolPanelExpansionTransfer,
  type AgentToolPanelDefinition
} from "./model.ts";

const panels: readonly AgentToolPanelDefinition[] = [
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" }
];

describe("agent tool sidebar model", () => {
  it("keeps only unique supported panels in host order", () => {
    expect(
      filterAgentToolPanels([
        ...panels,
        { id: "files", label: "Duplicate" },
        { id: "unsupported", label: "Unsupported" }
      ])
    ).toEqual(panels);
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
