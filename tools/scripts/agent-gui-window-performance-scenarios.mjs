import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
import {
  requiredScenarioData,
  sqlString,
  startupWorkspaceID
} from "./agent-gui-performance-snapshot-helpers.mjs";

const workbenchDragPointerMoveCount = 120;
const workbenchStressAgentGUIWindowCount = 50;
const workbenchStressExposedWindowCount = 6;
const tileMemoryWarning =
  "WARNING: tile memory limits exceeded, some content may not draw";
const workbenchWindowDragMarkers = buildMarkers("workbench-window-drag", []);
const workbenchFiftyWindowStressMarkers = buildMarkers(
  "workbench-fifty-window-stress",
  []
);

export const workbenchWindowDragScenario = {
  id: "workbench-window-drag",
  markers: workbenchWindowDragMarkers,
  milestones: [],
  prepare: prepareWorkbenchWindowDrag,
  execute: executeWorkbenchWindowDrag,
  describe(prepared) {
    return `${prepared.windowCount} mounted AgentGUI windows; ${workbenchDragPointerMoveCount} pointer moves`;
  },
  summarize(prepared, result) {
    return summary(
      [
        { name: "window entered drag state", passed: result.dragStarted },
        { name: "window left drag state", passed: result.dragEnded },
        {
          name: "window followed the pointer",
          passed:
            Math.abs(result.deltaX - result.requestedDeltaX) <= 3 &&
            Math.abs(result.deltaY - result.requestedDeltaY) <= 1
        },
        {
          name: "drag emitted no tile-memory warnings",
          passed: result.tileMemoryWarnings === 0
        },
        {
          name: "startup emitted no tile-memory warnings",
          passed: result.startupTileMemoryWarnings === 0
        }
      ],
      [
        { label: "Mounted AgentGUI windows", value: prepared.windowCount },
        { label: "Pointer moves", value: workbenchDragPointerMoveCount },
        {
          label: "Observed movement",
          value: `${result.deltaX.toFixed(1)} × ${result.deltaY.toFixed(1)} px`
        },
        {
          label: "Drag tile-memory warnings",
          value: result.tileMemoryWarnings
        },
        {
          label: "Startup tile-memory warnings",
          value: result.startupTileMemoryWarnings
        }
      ],
      "trusted CDP pointer input moves one visible Workbench window while at least three AgentGUI windows remain mounted"
    );
  },
  assessTrace: assessWorkbenchWindowDragTrace
};

export const workbenchFiftyWindowStressScenario = {
  id: "workbench-fifty-window-stress",
  markers: workbenchFiftyWindowStressMarkers,
  milestones: [],
  prepareSnapshot: prepareFiftyWindowStressSnapshot,
  prepare: prepareWorkbenchFiftyWindowStress,
  execute: executeWorkbenchFiftyWindowStress,
  describe(prepared) {
    return `${prepared.windowCount} mounted AgentGUI windows; ${workbenchDragPointerMoveCount} pointer moves`;
  },
  summarize(prepared, result) {
    return summary(
      [
        {
          name: `${workbenchStressAgentGUIWindowCount} AgentGUI windows mounted`,
          passed: prepared.windowCount === workbenchStressAgentGUIWindowCount
        },
        {
          name: "background window became active",
          passed: result.focusSwitched
        },
        {
          name: "background body stayed mounted across focus",
          passed: result.bodyPreserved
        },
        {
          name: "geometric visibility keeps exposed bodies painted",
          passed:
            result.exposedBodyCountBeforeFocus ===
              workbenchStressExposedWindowCount &&
            result.hiddenBodyCountBeforeFocus ===
              workbenchStressAgentGUIWindowCount -
                workbenchStressExposedWindowCount &&
            result.switchBodyVisibleBeforeFocus
        },
        { name: "window entered drag state", passed: result.dragStarted },
        { name: "window left drag state", passed: result.dragEnded },
        {
          name: "window followed the pointer",
          passed:
            Math.abs(result.deltaX - result.requestedDeltaX) <= 3 &&
            Math.abs(result.deltaY - result.requestedDeltaY) <= 1
        },
        {
          name: "drag emitted no tile-memory warnings",
          passed: result.tileMemoryWarnings === 0
        },
        {
          name: "startup emitted no tile-memory warnings",
          passed: result.startupTileMemoryWarnings === 0
        }
      ],
      [
        { label: "Mounted AgentGUI windows", value: prepared.windowCount },
        { label: "Pointer moves", value: workbenchDragPointerMoveCount },
        {
          label: "Observed movement",
          value: `${result.deltaX.toFixed(1)} × ${result.deltaY.toFixed(1)} px`
        },
        {
          label: "Drag tile-memory warnings",
          value: result.tileMemoryWarnings
        },
        {
          label: "Startup tile-memory warnings",
          value: result.startupTileMemoryWarnings
        },
        {
          label: "Exposed bodies before focus",
          value: result.exposedBodyCountBeforeFocus
        },
        {
          label: "Fully occluded bodies before focus",
          value: result.hiddenBodyCountBeforeFocus
        }
      ],
      `trusted CDP pointer input moves one visible Workbench window while exactly ${workbenchStressAgentGUIWindowCount} AgentGUI windows remain mounted`
    );
  },
  assessTrace: assessWorkbenchWindowDragTrace
};

export function assessWorkbenchWindowDragTrace(traceSummary) {
  const animationIterationCount =
    traceSummary.inputEvents.animationiteration ?? 0;
  const maximumAnimationIterationCount = 20;
  const maximumRendererTaskMs = 50;
  const maximumObservedRendererTaskMs = traceSummary.timing.maxLongTaskMs;
  return {
    assertions: [
      {
        name: `drag animation iterations <= ${maximumAnimationIterationCount}`,
        passed: animationIterationCount <= maximumAnimationIterationCount
      },
      {
        name: `renderer task <= ${maximumRendererTaskMs} ms`,
        passed: maximumObservedRendererTaskMs <= maximumRendererTaskMs
      }
    ],
    details: [
      { label: "Drag animation iterations", value: animationIterationCount },
      {
        label: "Drag animation-iteration budget",
        value: maximumAnimationIterationCount
      },
      {
        label: "Maximum renderer task",
        value: `${maximumObservedRendererTaskMs} ms`
      },
      {
        label: "Renderer task budget",
        value: `${maximumRendererTaskMs} ms`
      }
    ]
  };
}

async function prepareFiftyWindowStressSnapshot(context) {
  const workspaceID = await startupWorkspaceID(context);
  const rows = await context.sqliteJSON(
    context.databasePath,
    `
SELECT snapshot_json AS snapshotJSON
FROM workspace_workbench_snapshots
WHERE workspace_id = '${sqlString(workspaceID)}'
LIMIT 1;
`
  );
  const snapshot = JSON.parse(rows[0]?.snapshotJSON ?? "null");
  const stressedSnapshot = prepareAgentGUIWindowStressSnapshot(
    snapshot,
    workbenchStressAgentGUIWindowCount
  );
  await context.sqliteExec(
    context.databasePath,
    `
UPDATE workspace_workbench_snapshots
SET snapshot_json = '${sqlString(JSON.stringify(stressedSnapshot))}'
WHERE workspace_id = '${sqlString(workspaceID)}';
`
  );
  return {
    data: {
      expectedWindowCount: workbenchStressAgentGUIWindowCount
    }
  };
}

export function prepareAgentGUIWindowStressSnapshot(snapshot, windowCount) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.nodes) ||
    !Number.isInteger(windowCount) ||
    windowCount < 1
  ) {
    throw new Error("invalid AgentGUI window stress snapshot input");
  }
  const template =
    snapshot.nodes.find(
      (node) =>
        node?.id === snapshot.activeNodeId && node?.data?.typeId === "agent-gui"
    ) ?? snapshot.nodes.find((node) => node?.data?.typeId === "agent-gui");
  if (!template) {
    throw new Error("AgentGUI window stress snapshot has no template node");
  }
  const retainedNodes = snapshot.nodes.filter(
    (node) => node?.data?.typeId !== "agent-gui"
  );
  const agentGuiNodes = Array.from({ length: windowCount }, (_, index) => {
    const instanceID = `agent-gui:instance:perf-stress-${index + 1}`;
    const node = structuredClone(template);
    node.id = `agent-gui:${instanceID}`;
    node.data = {
      ...node.data,
      instanceId: instanceID,
      instanceKey: null
    };
    node.frame = stressAgentGUIWindowFrame(template.frame, index, windowCount);
    node.isMinimized = false;
    return node;
  });
  const activeNodeID = agentGuiNodes.at(-1).id;
  return {
    ...snapshot,
    activeNodeId: activeNodeID,
    nodeStack: [
      ...retainedNodes.map((node) => node.id),
      ...agentGuiNodes.map((node) => node.id)
    ],
    nodes: [...retainedNodes, ...agentGuiNodes]
  };
}

function stressAgentGUIWindowFrame(template, index, windowCount) {
  if (windowCount < workbenchStressExposedWindowCount) {
    return { ...template };
  }
  const hiddenWindowCount = windowCount - workbenchStressExposedWindowCount;
  const gap = Math.min(160, template.width * 0.2, template.height * 0.2);
  const width = (template.width - gap) / 2;
  const height = (template.height - gap) / 2;
  const left = template.x;
  const top = template.y;
  const right = left + width + gap;
  const bottom = top + height + gap;
  const frames = [
    {
      ...template,
      x: left + width - 120,
      y: top + 80,
      width: 400,
      height: Math.max(240, height - 160)
    },
    {
      ...template,
      x: left + 80,
      y: top + height - 120,
      width: Math.max(400, width - 160),
      height: 400
    },
    { ...template, x: left, y: top, width, height },
    { ...template, x: right, y: top, width, height },
    { ...template, x: left, y: bottom, width, height },
    { ...template, x: right, y: bottom, width, height }
  ];
  return index < hiddenWindowCount
    ? { ...frames[2] }
    : frames[index - hiddenWindowCount];
}

async function prepareWorkbenchFiftyWindowStress(context, options) {
  const scenarioData = requiredScenarioData(
    context,
    "workbench-fifty-window-stress"
  );
  const prepared = await prepareWorkbenchWindowDrag(
    context,
    options,
    scenarioData.expectedWindowCount
  );
  const switchTarget = await waitForEvaluation(
    context.pageClient,
    `(() => {
      const shells = [...document.querySelectorAll('[data-workbench-window-id][data-workbench-node-type-id="agent-gui"]')]
        .filter((shell) =>
          shell instanceof HTMLElement &&
          shell.dataset.workbenchWindowId !== ${JSON.stringify(prepared.nodeID)} &&
          shell.querySelector('[data-agent-gui-visible="true"]') != null
        )
        .sort((left, right) =>
          Number.parseInt(getComputedStyle(right).zIndex || '0', 10) -
          Number.parseInt(getComputedStyle(left).zIndex || '0', 10)
        );
      for (const shell of shells) {
        const header = shell.querySelector('.workbench-window__header');
        if (!(header instanceof HTMLElement)) continue;
        const rect = header.getBoundingClientRect();
        for (let offsetX = 8; offsetX < rect.width - 8; offsetX += 4) {
          const x = rect.left + offsetX;
          const y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !header.contains(hit) || hit.closest('button')) continue;
          return {
            ready: true,
            switchNodeID: shell.dataset.workbenchWindowId ?? '',
            switchX: x,
            switchY: y
          };
        }
      }
      return { ready: false };
    })()`,
    options.timeoutMs,
    "exposed background AgentGUI window header"
  );
  return { ...prepared, ...switchTarget };
}

async function executeWorkbenchFiftyWindowStress(context, prepared, options) {
  const { pageClient } = context;
  const mountSentinel = `perf-${Date.now()}`;
  const visibilityBeforeFocus = await evaluate(
    pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.switchNodeID}"]`)});
      const body = shell?.querySelector('[data-agent-gui-active="false"]');
      if (!(body instanceof HTMLElement)) {
        throw new Error('background AgentGUI body is unavailable before focus switch');
      }
      body.dataset.perfMountSentinel = ${JSON.stringify(mountSentinel)};
      const bodies = [
        ...document.querySelectorAll('.agent-gui-node__layout[data-agent-gui-visible]')
      ];
      return {
        exposedBodyCountBeforeFocus: bodies.filter(
          (candidate) => candidate.getAttribute('data-agent-gui-visible') === 'true'
        ).length,
        hiddenBodyCountBeforeFocus: bodies.filter(
          (candidate) => candidate.getAttribute('data-agent-gui-visible') === 'false'
        ).length,
        switchBodyVisibleBeforeFocus:
          body.getAttribute('data-agent-gui-visible') === 'true' &&
          getComputedStyle(body).contentVisibility !== 'hidden'
      };
    })()`
  );
  const tileWarningsAtStart = await countTileMemoryWarnings(
    context.outputDirectory
  );
  await startRendererScenario(
    pageClient,
    workbenchFiftyWindowStressMarkers.start
  );
  await pageClient.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: prepared.switchX,
    y: prepared.switchY
  });
  await pageClient.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: prepared.switchX,
    y: prepared.switchY
  });
  const focused = await waitForEvaluation(
    pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.switchNodeID}"]`)});
      const previousShell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.nodeID}"]`)});
      const body = shell?.querySelector('[data-agent-gui-active="true"]');
      const previousBody = previousShell?.querySelector('[data-agent-gui-active="false"]');
      return {
        ready:
          body instanceof HTMLElement &&
          previousBody instanceof HTMLElement &&
          body.getAttribute('data-agent-gui-visible') === 'true' &&
          getComputedStyle(body).contentVisibility !== 'hidden',
        bodyPreserved:
          body instanceof HTMLElement &&
          body.dataset.perfMountSentinel === ${JSON.stringify(mountSentinel)}
      };
    })()`,
    options.timeoutMs,
    "background AgentGUI focus switch"
  );
  const dragTarget = await waitForEvaluation(
    pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.switchNodeID}"]`)});
      const header = shell?.querySelector('.workbench-window__header');
      if (!(shell instanceof HTMLElement) || !(header instanceof HTMLElement)) {
        return { ready: false };
      }
      const headerRect = header.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      for (const fraction of [0.5, 0.4, 0.6, 0.3]) {
        const x = headerRect.left + headerRect.width * fraction;
        const y = headerRect.top + headerRect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !header.contains(hit) || hit.closest('button')) continue;
        const availableRight = window.innerWidth - shellRect.right;
        const availableLeft = shellRect.left;
        return {
          ready: true,
          nodeID: shell.dataset.workbenchWindowId ?? '',
          startX: x,
          startY: y,
          startLeft: shellRect.left,
          startTop: shellRect.top,
          deltaX: availableRight >= 120
            ? 120
            : availableLeft >= 120
              ? -120
              : Math.max(40, Math.min(120, availableRight)) * 0.75,
          deltaY: 0
        };
      }
      return { ready: false };
    })()`,
    options.timeoutMs,
    "focused AgentGUI drag target"
  );
  const dragResult = await executeWorkbenchWindowDrag(
    context,
    { ...prepared, ...dragTarget },
    options,
    workbenchFiftyWindowStressMarkers,
    { scenarioStarted: true, tileWarningsAtStart }
  );
  return {
    ...dragResult,
    bodyPreserved: focused.bodyPreserved,
    focusSwitched: focused.ready,
    ...visibilityBeforeFocus
  };
}

async function prepareWorkbenchWindowDrag(
  context,
  options,
  minimumWindowCount = 3
) {
  await waitForEvaluation(
    context.pageClient,
    "({ ready: document.documentElement !== null })",
    options.timeoutMs,
    "renderer document root"
  );
  await waitForWorkbenchRendererQuiet(context.pageClient);
  await waitForWorkbenchRendererIdle(context.pageClient);
  await waitForEvaluation(
    context.pageClient,
    `(() => {
      const shells = [...document.querySelectorAll('[data-workbench-window-id][data-workbench-node-type-id="agent-gui"]')]
        .filter((shell) =>
          shell instanceof HTMLElement &&
          shell.dataset.minimizedMount === 'visible' &&
          shell.dataset.presentationVisibility === 'visible' &&
          getComputedStyle(shell).visibility !== 'hidden'
        )
      const pendingHydrationCount = document.querySelectorAll(
        '[data-agent-gui-workbench-hydration="pending"]'
      ).length;
      return {
        ready: shells.length >= ${minimumWindowCount} && pendingHydrationCount === 0,
        windowCount: shells.length,
        pendingHydrationCount
      };
    })()`,
    options.timeoutMs,
    "all staged AgentGUI Workbench bodies"
  );
  await waitForWorkbenchRendererQuiet(context.pageClient);
  await waitForWorkbenchRendererIdle(context.pageClient);
  return waitForEvaluation(
    context.pageClient,
    `(() => {
      const shells = [...document.querySelectorAll('[data-workbench-window-id][data-workbench-node-type-id="agent-gui"]')]
        .filter((shell) =>
          shell instanceof HTMLElement &&
          shell.dataset.minimizedMount === 'visible' &&
          shell.dataset.presentationVisibility === 'visible' &&
          getComputedStyle(shell).visibility !== 'hidden'
        )
        .sort((left, right) =>
          Number.parseInt(getComputedStyle(right).zIndex || '0', 10) -
          Number.parseInt(getComputedStyle(left).zIndex || '0', 10)
        );
      for (const shell of shells) {
        const header = shell.querySelector('.workbench-window__header');
        if (!(header instanceof HTMLElement)) continue;
        const headerRect = header.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        for (const fraction of [0.5, 0.4, 0.6, 0.3]) {
          const x = headerRect.left + headerRect.width * fraction;
          const y = headerRect.top + headerRect.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !header.contains(hit) || hit.closest('button')) continue;
          const availableRight = window.innerWidth - shellRect.right;
          const availableLeft = shellRect.left;
          const deltaX = availableRight >= 120
            ? 120
            : availableLeft >= 120
              ? -120
              : Math.max(40, Math.min(120, availableRight)) * 0.75;
          const deltaY = 0;
          return {
            ready: shells.length >= ${minimumWindowCount},
            windowCount: shells.length,
            nodeID: shell.dataset.workbenchWindowId ?? '',
            startX: x,
            startY: y,
            startLeft: shellRect.left,
            startTop: shellRect.top,
            deltaX,
            deltaY
          };
        }
      }
      return {
        ready: false,
        windowCount: shells.length
      };
    })()`,
    options.timeoutMs,
    `${minimumWindowCount} mounted AgentGUI windows with a draggable top window`
  );
}

export async function waitForWorkbenchRendererQuiet(pageClient) {
  await evaluate(
    pageClient,
    `new Promise((resolve) => {
      let quietTimer = 0;
      const timeout = setTimeout(finish, 15000);
      const observer = new MutationObserver(schedule);
      function finish() {
        clearTimeout(timeout);
        clearTimeout(quietTimer);
        observer.disconnect();
        resolve(true);
      }
      function schedule() {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          if ([...document.images].every((image) => image.complete)) finish();
          else schedule();
        }, 1000);
      }
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true
      });
      schedule();
    })`,
    true
  );
}

export async function waitForWorkbenchRendererIdle(pageClient) {
  await evaluate(
    pageClient,
    `new Promise((resolve) => {
      const afterIdle = () =>
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      if (typeof requestIdleCallback !== 'function') {
        setTimeout(afterIdle, 1000);
        return;
      }
      requestIdleCallback(
        () => requestIdleCallback(afterIdle, { timeout: 5000 }),
        { timeout: 5000 }
      );
    })`,
    true
  );
}

async function executeWorkbenchWindowDrag(
  context,
  prepared,
  options,
  markers = workbenchWindowDragMarkers,
  measurement = {}
) {
  const { pageClient } = context;
  await pageClient.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: prepared.startX,
    y: prepared.startY
  });
  const dragging = await waitForEvaluation(
    pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.nodeID}"]`)});
      return { ready: shell?.dataset.windowDragState === 'dragging' };
    })()`,
    options.timeoutMs,
    "Workbench window drag state"
  );
  await evaluate(
    pageClient,
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    true
  );
  await delay(100);
  const tileWarningsAtStart =
    measurement.tileWarningsAtStart ??
    (await countTileMemoryWarnings(context.outputDirectory));
  if (!measurement.scenarioStarted) {
    await startRendererScenario(pageClient, markers.start);
  }

  for (let index = 1; index <= workbenchDragPointerMoveCount; index += 1) {
    const progress = index / workbenchDragPointerMoveCount;
    await pageClient.send("Input.dispatchMouseEvent", {
      button: "left",
      buttons: 1,
      type: "mouseMoved",
      x: prepared.startX + prepared.deltaX * progress,
      y: prepared.startY + prepared.deltaY * progress
    });
    await delay(8);
  }
  await evaluate(
    pageClient,
    `new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          console.timeStamp(${JSON.stringify(markers.end)});
          resolve(true);
        })
      )
    )`,
    true
  );
  await delay(100);
  const tileWarningsAtEnd = await countTileMemoryWarnings(
    context.outputDirectory
  );
  await pageClient.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: prepared.startX + prepared.deltaX,
    y: prepared.startY + prepared.deltaY
  });

  const settled = await waitForEvaluation(
    pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.nodeID}"]`)});
      if (!(shell instanceof HTMLElement)) return { ready: false };
      const rect = shell.getBoundingClientRect();
      return {
        ready: shell.dataset.windowDragState === 'idle',
        deltaX: rect.left - ${prepared.startLeft},
        deltaY: rect.top - ${prepared.startTop}
      };
    })()`,
    options.timeoutMs,
    "settled Workbench window drag"
  );
  return {
    deltaX: settled.deltaX,
    deltaY: settled.deltaY,
    dragEnded: settled.ready,
    dragStarted: dragging.ready,
    requestedDeltaX: prepared.deltaX,
    requestedDeltaY: prepared.deltaY,
    startupTileMemoryWarnings: tileWarningsAtStart,
    tileMemoryWarnings: Math.max(0, tileWarningsAtEnd - tileWarningsAtStart)
  };
}

async function countTileMemoryWarnings(outputDirectory) {
  try {
    const log = await readFile(join(outputDirectory, "desktop.log"), "utf8");
    return log.split(tileMemoryWarning).length - 1;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

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
