import {
  clickAgentWindowControl,
  evaluate,
  finishRendererScenario,
  markRenderer,
  selectProvider,
  startRendererScenario,
  waitForAgentWorkbenchWindow,
  waitForProviderTiles,
  waitForStableAgentWorkbenchWindow,
  waitForStableViewport,
  waitForEvaluation
} from "./agent-gui-performance-helpers.mjs";

const workbenchSteps = [
  ["minimized", "internal window minimized"],
  ["restored", "internal window restored"],
  ["maximized", "internal window maximized"],
  ["unmaximized", "internal window restored from maximized"],
  ["closed", "internal window closed"],
  ["reopened", "internal window reopened"]
];
const workbenchMarkers = buildMarkers(
  "workbench-window-lifecycle",
  workbenchSteps
);

export const workbenchWindowLifecycleScenario = {
  id: "workbench-window-lifecycle",
  markers: workbenchMarkers,
  milestones: milestones(workbenchMarkers, workbenchSteps),
  prepare: prepareWorkbenchWindow,
  execute: executeWorkbenchWindow,
  describe(prepared) {
    return `${prepared.nodeID}; minimize/restore/maximize/restore/close/open`;
  },
  summarize(prepared, result) {
    const assertions = [
      { name: "window minimized", passed: result.minimized },
      { name: "window restored", passed: result.restored },
      { name: "window maximized", passed: result.maximized },
      { name: "window unmaximized", passed: result.unmaximized },
      { name: "window closed", passed: result.closed },
      {
        name: "window reopened",
        passed: result.reopened && result.reopenedNodeID !== prepared.nodeID
      }
    ];
    return summary(
      assertions,
      [
        { label: "Window", value: "AgentGUI Workbench node" },
        { label: "Original node", value: prepared.nodeID },
        { label: "Reopened node", value: result.reopenedNodeID },
        { label: "Measured operations", value: "6" }
      ],
      "each DOM shell/dock state observed before next operation; two animation frames plus 250 ms settling tail"
    );
  }
};

async function prepareWorkbenchWindow(context, options) {
  const { pageClient } = context;
  const providers = await waitForProviderTiles(pageClient, options.timeoutMs);
  const targetID = providers.selectedTargetID ?? providers.tiles[0]?.targetID;
  if (!targetID) {
    throw new Error("workbench-window-lifecycle has no Agent target");
  }
  await selectProvider(pageClient, targetID, options.timeoutMs);
  let windowState = await waitForStableAgentWorkbenchWindow(
    pageClient,
    options.timeoutMs
  );
  if (windowState.displayMode === "fullscreen") {
    await clickAgentWindowControl(
      pageClient,
      windowState.id,
      "agent-gui-window-toggle-display-mode"
    );
    const restored = await waitForAgentWorkbenchWindow(
      pageClient,
      options.timeoutMs,
      "windowState?.displayMode === 'floating'",
      "floating AgentGUI Workbench window",
      windowState.id
    );
    windowState = { ...windowState, ...restored.windowState };
  }
  return { nodeID: windowState.id };
}

async function executeWorkbenchWindow(context, prepared, options) {
  const { pageClient } = context;
  const result = {};
  await startRendererScenario(pageClient, workbenchMarkers.start);

  await clickAgentWindowControl(
    pageClient,
    prepared.nodeID,
    "agent-gui-window-minimize"
  );
  const minimized = await waitForEvaluation(
    pageClient,
    `(() => {
      const slot = document.querySelector(${JSON.stringify(`[data-desktop-dock-anchor-key="minimized:${prepared.nodeID}"]`)});
      return { ready: Boolean(slot) };
    })()`,
    options.timeoutMs,
    "minimized AgentGUI Workbench dock item"
  );
  result.minimized = minimized.ready;
  await markRenderer(pageClient, workbenchMarkers.minimized);

  await evaluate(
    pageClient,
    `(() => {
      const slot = document.querySelector(${JSON.stringify(`[data-desktop-dock-anchor-key="minimized:${prepared.nodeID}"]`)});
      const button = slot?.querySelector('[role="button"]');
      if (!(button instanceof HTMLElement)) throw new Error('minimized AgentGUI dock item is unavailable');
      button.click();
      return true;
    })()`
  );
  const restored = await waitForAgentWorkbenchWindow(
    pageClient,
    options.timeoutMs,
    "windowState?.minimizedMount === 'visible'",
    "restored AgentGUI Workbench window",
    prepared.nodeID
  );
  result.restored = restored.ready;
  await markRenderer(pageClient, workbenchMarkers.restored);

  await clickAgentWindowControl(
    pageClient,
    prepared.nodeID,
    "agent-gui-window-toggle-display-mode"
  );
  const maximized = await waitForAgentWorkbenchWindow(
    pageClient,
    options.timeoutMs,
    "windowState?.displayMode === 'fullscreen'",
    "fullscreen AgentGUI Workbench window",
    prepared.nodeID
  );
  result.maximized = maximized.ready;
  await markRenderer(pageClient, workbenchMarkers.maximized);

  await clickAgentWindowControl(
    pageClient,
    prepared.nodeID,
    "agent-gui-window-toggle-display-mode"
  );
  const unmaximized = await waitForAgentWorkbenchWindow(
    pageClient,
    options.timeoutMs,
    "windowState?.displayMode === 'floating'",
    "unmaximized AgentGUI Workbench window",
    prepared.nodeID
  );
  result.unmaximized = unmaximized.ready;
  await waitForEvaluation(
    pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.nodeID}"]`)});
      return { ready: Boolean(shell?.querySelector('[data-testid="agent-gui-window-close"]')) };
    })()`,
    options.timeoutMs,
    "AgentGUI close control after unmaximize"
  );
  await markRenderer(pageClient, workbenchMarkers.unmaximized);

  await clickAgentWindowControl(
    pageClient,
    prepared.nodeID,
    "agent-gui-window-close"
  );
  const closed = await waitForAgentWorkbenchWindow(
    pageClient,
    options.timeoutMs,
    "windowState === null",
    "closed AgentGUI Workbench window",
    prepared.nodeID
  );
  result.closed = closed.ready;
  await markRenderer(pageClient, workbenchMarkers.closed);

  await evaluate(
    pageClient,
    `(() => {
      const slot = document.querySelector('[data-desktop-dock-anchor-key="agent-gui:unified"]');
      const button = slot?.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) throw new Error('AgentGUI dock launcher is unavailable');
      button.click();
      return true;
    })()`
  );
  const reopened = await waitForAgentWorkbenchWindow(
    pageClient,
    options.timeoutMs,
    `Boolean(windowState?.id && windowState.id !== ${JSON.stringify(prepared.nodeID)})`,
    "reopened AgentGUI Workbench window"
  );
  result.reopened = reopened.ready;
  result.reopenedNodeID = reopened.windowState?.id ?? "";
  await markRenderer(pageClient, workbenchMarkers.reopened);
  await finishRendererScenario(pageClient, workbenchMarkers.end);
  return result;
}

const desktopSteps = [
  ["minimized", "native window minimized"],
  ["restored", "native window restored"],
  ["maximized", "native window maximized"],
  ["unmaximized", "native window restored from maximized"]
];
const desktopMarkers = buildMarkers("desktop-window-state", desktopSteps);

export const desktopWindowStateScenario = {
  id: "desktop-window-state",
  markers: desktopMarkers,
  milestones: milestones(desktopMarkers, desktopSteps),
  prepare: prepareDesktopWindow,
  execute: executeDesktopWindow,
  describe(prepared) {
    return `workspace ${prepared.workspaceID}; minimize/restore/maximize/restore`;
  },
  summarize(prepared, result) {
    const assertions = [
      { name: "window minimized", passed: result.minimized },
      { name: "window restored", passed: result.restored },
      { name: "window maximized", passed: result.maximized },
      { name: "window unmaximized", passed: result.unmaximized }
    ];
    return summary(
      assertions,
      [
        {
          label: "Window",
          value: "owning Electron BrowserWindow"
        },
        { label: "Workspace", value: prepared.workspaceID },
        { label: "Measured operations", value: "4" },
        {
          label: "Excluded",
          value: "native close/reopen destroys the marker-owning renderer"
        }
      ],
      "typed host-window IPC performs each action; preload minimize/layout events confirm observed state"
    );
  }
};

async function prepareDesktopWindow(context, options) {
  if (process.platform !== "darwin") {
    throw new Error(
      "desktop-window-state currently requires macOS host-window minimize events"
    );
  }
  const { pageClient } = context;
  const prepared = await waitForEvaluation(
    pageClient,
    `(() => {
      const workspaceID = new URLSearchParams(location.search).get('workspaceId');
      const hostWindow = window.tutti?.host?.window;
      const hostWorkspace = window.tutti?.host?.workspace;
      return {
        ready: Boolean(workspaceID && hostWindow?.minimize && hostWindow?.toggleMaximize && hostWorkspace?.showWorkspace && document.querySelector('[data-app-header="true"]')),
        workspaceID,
        maximized: document.documentElement?.dataset.tuttiWindowMaximized === 'true'
      };
    })()`,
    options.timeoutMs,
    "native host-window APIs"
  );
  if (prepared.maximized) {
    await evaluate(
      pageClient,
      "window.tutti.host.window.toggleMaximize()",
      true
    );
    await waitForEvaluation(
      pageClient,
      "({ ready: document.documentElement?.dataset.tuttiWindowMaximized !== 'true' })",
      options.timeoutMs,
      "normal native window before scenario"
    );
    await waitForStableViewport(pageClient, options.timeoutMs);
  }
  return prepared;
}

async function executeDesktopWindow(context, prepared, options) {
  const { pageClient } = context;
  await evaluate(
    pageClient,
    `(() => {
      window.__tuttiPerfWindowState = {
        maximized: document.documentElement.dataset.tuttiWindowMaximized === 'true',
        minimized: false
      };
      window.addEventListener('tutti-host-window-minimize', (event) => {
        window.__tuttiPerfWindowState.minimized = event.detail?.minimized === true;
      });
      window.addEventListener('tutti-host-window-layout', (event) => {
        window.__tuttiPerfWindowState.maximized = event.detail?.maximized === true;
      });
      return true;
    })()`
  );
  await startRendererScenario(pageClient, desktopMarkers.start);
  await evaluate(pageClient, "window.tutti.host.window.minimize()", true);
  const minimized = await waitForEvaluation(
    pageClient,
    "({ ready: window.__tuttiPerfWindowState?.minimized === true })",
    options.timeoutMs,
    "minimized native window"
  );
  await markRenderer(pageClient, desktopMarkers.minimized);
  await evaluate(
    pageClient,
    `window.tutti.host.workspace.showWorkspace(${JSON.stringify(prepared.workspaceID)})`,
    true
  );
  const restored = await waitForEvaluation(
    pageClient,
    "({ ready: window.__tuttiPerfWindowState?.minimized === false })",
    options.timeoutMs,
    "restored native window"
  );
  await markRenderer(pageClient, desktopMarkers.restored);
  await evaluate(pageClient, "window.tutti.host.window.toggleMaximize()", true);
  const maximized = await waitForEvaluation(
    pageClient,
    "({ ready: window.__tuttiPerfWindowState?.maximized === true })",
    options.timeoutMs,
    "maximized native window"
  );
  await waitForStableViewport(pageClient, options.timeoutMs);
  await markRenderer(pageClient, desktopMarkers.maximized);
  await evaluate(pageClient, "window.tutti.host.window.toggleMaximize()", true);
  const unmaximized = await waitForEvaluation(
    pageClient,
    "({ ready: window.__tuttiPerfWindowState?.maximized === false })",
    options.timeoutMs,
    "unmaximized native window"
  );
  await waitForStableViewport(pageClient, options.timeoutMs);
  await markRenderer(pageClient, desktopMarkers.unmaximized);
  await finishRendererScenario(pageClient, desktopMarkers.end);
  return {
    maximized: maximized.ready,
    minimized: minimized.ready,
    restored: restored.ready,
    unmaximized: unmaximized.ready
  };
}

function buildMarkers(scenarioID, steps) {
  return Object.fromEntries([
    ["start", `tutti-perf:${scenarioID}:start`],
    ...steps.map(([key]) => [key, `tutti-perf:${scenarioID}:${key}-observed`]),
    ["end", `tutti-perf:${scenarioID}:end`]
  ]);
}

function milestones(markers, steps) {
  return steps.map(([key, label]) => ({ key, label, marker: markers[key] }));
}

function summary(assertions, details, stabilityCriterion) {
  return {
    outcome: assertions.every((assertion) => assertion.passed)
      ? "passed"
      : "failed",
    assertions,
    details,
    stabilityCriterion
  };
}
