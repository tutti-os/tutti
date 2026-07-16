import assert from "node:assert/strict";
import test from "node:test";
import {
  clampStandaloneAgentToolPanelWidth,
  createStandaloneAgentToolSidebarState,
  formatStandaloneAgentToolReminderCount,
  isStandaloneAgentToolGroupActive,
  reduceStandaloneAgentToolSidebarState,
  resolveStandaloneAgentToolPanelExpansionReset,
  resolveStandaloneAgentToolPanelExpansionTransfer,
  resolveStandaloneAgentToolPanelPreferredWidth,
  resolveStandaloneAgentToolSidebarLayoutWidth,
  resolveStandaloneAgentToolSidebarWidth,
  resolveStandaloneAgentToolPanelMaxWidth,
  shouldResizeStandaloneAgentToolWindow,
  standaloneAgentEmptyToolSidebarWidth,
  standaloneAgentToolPanelDefaultWidthById
} from "./standaloneAgentToolSidebarModel.ts";

test("standalone agent tool sidebar opens, swaps, and hides one active tab at a time", () => {
  const initial = createStandaloneAgentToolSidebarState();
  const filesOpen = reduceStandaloneAgentToolSidebarState(initial, {
    panel: "files",
    tabId: "files:1",
    type: "open-panel"
  });
  const appsOpen = reduceStandaloneAgentToolSidebarState(filesOpen, {
    panel: "apps",
    tabId: "apps:1",
    type: "open-panel"
  });
  const appsClosed = reduceStandaloneAgentToolSidebarState(appsOpen, {
    type: "close"
  });

  assert.equal(filesOpen.activePanel, "files");
  assert.equal(filesOpen.activeTabId, "files:1");
  assert.equal(appsOpen.activePanel, "apps");
  assert.equal(appsClosed.activePanel, null);
  assert.equal(appsClosed.activeTabId, null);
  assert.deepEqual(appsClosed.mountedTabs, [
    { id: "files:1", panel: "files" },
    { id: "apps:1", panel: "apps" }
  ]);
});

test("standalone agent tool sidebar opens each app in its own sibling tab beside the app store", () => {
  const storeOpen = reduceStandaloneAgentToolSidebarState(
    createStandaloneAgentToolSidebarState(),
    { panel: "apps", tabId: "apps:1", type: "open-panel" }
  );
  const appAOpen = reduceStandaloneAgentToolSidebarState(storeOpen, {
    appId: "app-a",
    panel: "apps",
    tabId: "apps:2",
    type: "open-panel"
  });
  const appBOpen = reduceStandaloneAgentToolSidebarState(appAOpen, {
    appId: "app-b",
    panel: "apps",
    tabId: "apps:3",
    type: "open-panel"
  });
  const appAReopened = reduceStandaloneAgentToolSidebarState(appBOpen, {
    appId: "app-a",
    panel: "apps",
    tabId: "apps:4",
    type: "open-panel"
  });

  assert.deepEqual(appBOpen.mountedTabs, [
    { id: "apps:1", panel: "apps" },
    { appId: "app-a", id: "apps:2", panel: "apps" },
    { appId: "app-b", id: "apps:3", panel: "apps" }
  ]);
  assert.equal(appAReopened.activeTabId, "apps:2");
  assert.deepEqual(appAReopened.mountedTabs, appBOpen.mountedTabs);
});

test("standalone agent right-sidebar panels are mutually exclusive for every switch", () => {
  const panels = ["files", "browser", "apps", "tasks", "messages"] as const;

  for (const previousPanel of panels) {
    for (const nextPanel of panels) {
      if (previousPanel === nextPanel) {
        continue;
      }
      const previousOpen = reduceStandaloneAgentToolSidebarState(
        createStandaloneAgentToolSidebarState(),
        {
          panel: previousPanel,
          tabId: `${previousPanel}:1`,
          type: "open-panel"
        }
      );
      const nextOpen = reduceStandaloneAgentToolSidebarState(previousOpen, {
        panel: nextPanel,
        tabId: `${nextPanel}:1`,
        type: "open-panel"
      });

      assert.equal(nextOpen.activePanel, nextPanel);
      assert.equal(
        nextOpen.mountedTabs.filter((tab) => tab.panel === nextPanel).length,
        1
      );
    }
  }
});

test("standalone agent tool sidebar opens a requested panel without toggling it closed", () => {
  const filesOpen = reduceStandaloneAgentToolSidebarState(
    createStandaloneAgentToolSidebarState(),
    { panel: "files", tabId: "files:1", type: "open-panel" }
  );
  const filesRequestedAgain = reduceStandaloneAgentToolSidebarState(filesOpen, {
    panel: "files",
    tabId: "files:2",
    type: "open-panel"
  });
  const appsOpen = reduceStandaloneAgentToolSidebarState(filesRequestedAgain, {
    panel: "apps",
    tabId: "apps:1",
    type: "open-panel"
  });

  assert.equal(filesRequestedAgain.activePanel, "files");
  assert.equal(filesRequestedAgain.activeTabId, "files:1");
  assert.deepEqual(filesRequestedAgain.mountedTabs, [
    { id: "files:1", panel: "files" }
  ]);
  assert.equal(appsOpen.activePanel, "apps");
  assert.deepEqual(appsOpen.mountedTabs, [
    { id: "files:1", panel: "files" },
    { id: "apps:1", panel: "apps" }
  ]);
});

test("standalone agent add menu creates another tab for an already mounted tool", () => {
  const filesOpen = reduceStandaloneAgentToolSidebarState(
    createStandaloneAgentToolSidebarState(),
    { panel: "files", tabId: "files:1", type: "add-panel" }
  );
  const secondFilesOpen = reduceStandaloneAgentToolSidebarState(filesOpen, {
    panel: "files",
    tabId: "files:2",
    type: "add-panel"
  });

  assert.equal(secondFilesOpen.activePanel, "files");
  assert.equal(secondFilesOpen.activeTabId, "files:2");
  assert.deepEqual(secondFilesOpen.mountedTabs, [
    { id: "files:1", panel: "files" },
    { id: "files:2", panel: "files" }
  ]);
});

test("standalone agent tool sidebar activates and closes individual duplicate tabs", () => {
  const firstFilesOpen = reduceStandaloneAgentToolSidebarState(
    createStandaloneAgentToolSidebarState(),
    { panel: "files", tabId: "files:1", type: "add-panel" }
  );
  const secondFilesOpen = reduceStandaloneAgentToolSidebarState(
    firstFilesOpen,
    { panel: "files", tabId: "files:2", type: "add-panel" }
  );
  const firstFilesActivated = reduceStandaloneAgentToolSidebarState(
    secondFilesOpen,
    { tabId: "files:1", type: "activate-tab" }
  );
  const firstFilesClosed = reduceStandaloneAgentToolSidebarState(
    firstFilesActivated,
    { tabId: "files:1", type: "close-tab" }
  );

  assert.equal(firstFilesActivated.activeTabId, "files:1");
  assert.equal(firstFilesClosed.activeTabId, "files:2");
  assert.deepEqual(firstFilesClosed.mountedTabs, [
    { id: "files:2", panel: "files" }
  ]);
});

test("standalone agent tool sidebar reports browser and terminal as one active group", () => {
  assert.equal(
    isStandaloneAgentToolGroupActive({
      activePanel: "browser",
      activeTabId: "browser:1",
      mountedTabs: [{ id: "browser:1", panel: "browser" }]
    }),
    true
  );
  assert.equal(
    isStandaloneAgentToolGroupActive({
      activePanel: "terminal",
      activeTabId: "terminal:1",
      mountedTabs: [{ id: "terminal:1", panel: "terminal" }]
    }),
    true
  );
  assert.equal(
    isStandaloneAgentToolGroupActive({
      activePanel: "apps",
      activeTabId: "apps:1",
      mountedTabs: [{ id: "apps:1", panel: "apps" }]
    }),
    false
  );
});

test("standalone agent tool sidebar normalizes reminder counts for compact badges", () => {
  assert.equal(formatStandaloneAgentToolReminderCount(undefined), null);
  assert.equal(formatStandaloneAgentToolReminderCount(-2), null);
  assert.equal(formatStandaloneAgentToolReminderCount(Number.NaN), null);
  assert.equal(formatStandaloneAgentToolReminderCount(1.8), "1");
  assert.equal(formatStandaloneAgentToolReminderCount(99), "99");
  assert.equal(formatStandaloneAgentToolReminderCount(100), "99+");
});

test("standalone agent browser and apps open at the same roomy default width", () => {
  assert.equal(standaloneAgentToolPanelDefaultWidthById.browser, 720);
  assert.equal(
    standaloneAgentToolPanelDefaultWidthById.apps,
    standaloneAgentToolPanelDefaultWidthById.browser
  );
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      mainContentMinWidth: 332,
      panel: "browser",
      viewportWidth: 1340,
      width: standaloneAgentToolPanelDefaultWidthById.browser
    }),
    720
  );
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      mainContentMinWidth: 332,
      panel: "apps",
      viewportWidth: 1340,
      width: standaloneAgentToolPanelDefaultWidthById.apps
    }),
    720
  );
});

test("standalone agent tool panels reuse the latest manual width across panels", () => {
  assert.equal(
    resolveStandaloneAgentToolPanelPreferredWidth({
      isExpanded: false,
      manuallyResizedWidth: 936,
      panelWidth: standaloneAgentToolPanelDefaultWidthById.browser
    }),
    936
  );
  assert.equal(
    resolveStandaloneAgentToolPanelPreferredWidth({
      isExpanded: true,
      manuallyResizedWidth: 936,
      panelWidth: Number.MAX_SAFE_INTEGER
    }),
    Number.MAX_SAFE_INTEGER
  );
  assert.equal(
    resolveStandaloneAgentToolPanelPreferredWidth({
      isExpanded: false,
      manuallyResizedWidth: null,
      panelWidth: standaloneAgentToolPanelDefaultWidthById.browser
    }),
    standaloneAgentToolPanelDefaultWidthById.browser
  );
});

test("standalone agent tool switches skip redundant native window resizes", () => {
  assert.equal(
    shouldResizeStandaloneAgentToolWindow({
      currentWidth: 2_100,
      requestedWidth: 2_100
    }),
    false
  );
  assert.equal(
    shouldResizeStandaloneAgentToolWindow({
      currentWidth: 2_000,
      lastResize: { actualWidth: 2_000, requestedWidth: 2_100 },
      requestedWidth: 2_100
    }),
    false
  );
  assert.equal(
    shouldResizeStandaloneAgentToolWindow({
      currentWidth: 2_000,
      requestedWidth: 2_100
    }),
    true
  );
});

test("standalone agent empty tool sidebar uses sixty percent of the file panel width", () => {
  assert.equal(
    standaloneAgentEmptyToolSidebarWidth,
    standaloneAgentToolPanelDefaultWidthById.files * 0.6
  );
  assert.equal(standaloneAgentEmptyToolSidebarWidth, 432);
});

test("standalone agent messages open wide enough for message cards", () => {
  assert.equal(standaloneAgentToolPanelDefaultWidthById.messages, 440);
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      mainContentMinWidth: 332,
      panel: "messages",
      viewportWidth: 1340,
      width: standaloneAgentToolPanelDefaultWidthById.messages
    }),
    440
  );
});

test("standalone agent tasks open at the issue-manager workbench width", () => {
  assert.equal(standaloneAgentToolPanelDefaultWidthById.tasks, 860);
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      mainContentMinWidth: 332,
      panel: "tasks",
      viewportWidth: 1440,
      width: standaloneAgentToolPanelDefaultWidthById.tasks
    }),
    860
  );
});

test("standalone agent file sidebar opens beside the conversation at the roomy shared width", () => {
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      panel: "files",
      viewportWidth: 1440,
      width: standaloneAgentToolPanelDefaultWidthById.files
    }),
    720
  );
  assert.equal(standaloneAgentToolPanelDefaultWidthById.files, 720);
});

test("standalone agent tool sidebar assigns native outward growth to the sidebar", () => {
  assert.equal(
    resolveStandaloneAgentToolSidebarWidth({
      baselineViewportWidth: 1200,
      mainContentMinWidth: 332,
      panel: "files",
      preferredWidth: 720,
      viewportWidth: 1920
    }),
    720
  );
  assert.equal(
    resolveStandaloneAgentToolSidebarWidth({
      baselineViewportWidth: 1200,
      mainContentMinWidth: 332,
      panel: "browser",
      preferredWidth: 720,
      viewportWidth: 2080
    }),
    880
  );
});

test("standalone agent tool sidebar always reserves its full width beside the message flow", () => {
  const panelWidth = resolveStandaloneAgentToolSidebarWidth({
    baselineViewportWidth: 1200,
    mainContentMinWidth: 332,
    panel: "apps",
    preferredWidth: 720,
    viewportWidth: 1560
  });
  assert.equal(panelWidth, 720);
  assert.equal(
    resolveStandaloneAgentToolSidebarLayoutWidth({
      baselineViewportWidth: 1200,
      panelWidth,
      viewportWidth: 1560
    }),
    720
  );
  assert.equal(resolveStandaloneAgentToolPanelMaxWidth("apps", 1920), 1200);
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      allowFullWidth: true,
      panel: "apps",
      viewportWidth: 1920,
      width: Number.MAX_SAFE_INTEGER
    }),
    1640
  );
});

test("standalone agent tool panels stop at the actual header rail boundary", () => {
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      mainContentMinWidth: 332,
      panel: "files",
      viewportWidth: 1340,
      width: Number.MAX_SAFE_INTEGER
    }),
    1008
  );
  assert.equal(
    clampStandaloneAgentToolPanelWidth({
      mainContentMinWidth: 332,
      panel: "files",
      viewportWidth: 760,
      width: Number.MAX_SAFE_INTEGER
    }),
    428
  );
  assert.equal(
    resolveStandaloneAgentToolPanelMaxWidth("files", 760, false, 332),
    428
  );
});

test("standalone agent tool panel restores its width when an expanded panel closes or switches", () => {
  assert.deepEqual(
    resolveStandaloneAgentToolPanelExpansionReset({
      expandedPanel: "browser",
      nextPanel: null,
      widthBeforeExpansion: 720
    }),
    { panel: "browser", width: 720 }
  );
  assert.deepEqual(
    resolveStandaloneAgentToolPanelExpansionReset({
      expandedPanel: "browser",
      nextPanel: "files",
      widthBeforeExpansion: 680
    }),
    { panel: "browser", width: 680 }
  );
  assert.equal(
    resolveStandaloneAgentToolPanelExpansionReset({
      expandedPanel: "browser",
      nextPanel: "browser",
      widthBeforeExpansion: 720
    }),
    null
  );
  assert.equal(
    resolveStandaloneAgentToolSidebarWidth({
      baselineViewportWidth: 1200,
      mainContentMinWidth: 332,
      panel: "browser",
      preferredWidth:
        resolveStandaloneAgentToolPanelExpansionReset({
          expandedPanel: "browser",
          nextPanel: null,
          widthBeforeExpansion: 720
        })?.width ?? Number.MAX_SAFE_INTEGER,
      viewportWidth: 1920
    }),
    720
  );
});

test("standalone agent tool panel transfers expansion when switching tabs", () => {
  assert.deepEqual(
    resolveStandaloneAgentToolPanelExpansionTransfer({
      expandedPanel: "files",
      nextPanel: "terminal",
      nextPanelWidth: 720,
      widthBeforeExpansion: 680
    }),
    {
      expandedPanel: "terminal",
      nextPanelWidthBeforeExpansion: 720,
      previousPanel: "files",
      previousPanelWidth: 680
    }
  );
  assert.equal(
    resolveStandaloneAgentToolPanelExpansionTransfer({
      expandedPanel: "files",
      nextPanel: null,
      nextPanelWidth: 720,
      widthBeforeExpansion: 680
    }),
    null
  );
});
