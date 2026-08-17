import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluate,
  finishRendererScenario,
  markRenderer,
  startRendererScenario,
  waitForEvaluation
} from "./agent-gui-performance-helpers.mjs";
import {
  requiredScenarioData,
  sqlString,
  startupWorkspaceID
} from "./agent-gui-performance-snapshot-helpers.mjs";
import {
  prepareAgentGUIWindowStressSnapshot,
  waitForWorkbenchRendererIdle,
  waitForWorkbenchRendererQuiet
} from "./agent-gui-window-performance-scenarios.mjs";

const dockPopupPreviewWindowCount = 50;
const dockPopupPreviewScreenshot = "workbench-dock-popup-preview.png";
const dockPopupPreviewMarkers = {
  start: "tutti-perf:workbench-dock-popup-preview:start",
  opened: "tutti-perf:workbench-dock-popup-preview:opened-observed",
  ready: "tutti-perf:workbench-dock-popup-preview:ready-observed",
  captured: "tutti-perf:workbench-dock-popup-preview:captured-observed",
  end: "tutti-perf:workbench-dock-popup-preview:end"
};

export const workbenchDockPopupPreviewScenario = {
  id: "workbench-dock-popup-preview",
  markers: dockPopupPreviewMarkers,
  milestones: [
    {
      key: "opened",
      label: "Dock popup opened",
      marker: dockPopupPreviewMarkers.opened
    },
    {
      key: "ready",
      label: "all preview images ready",
      marker: dockPopupPreviewMarkers.ready
    },
    {
      key: "captured",
      label: "Dock popup pixels captured",
      marker: dockPopupPreviewMarkers.captured
    }
  ],
  prepareSnapshot: prepareWorkbenchDockPopupPreviewDatabaseSnapshot,
  prepare: prepareWorkbenchDockPopupPreview,
  execute: executeWorkbenchDockPopupPreview,
  describe(prepared) {
    return `${prepared.expectedNodeIDs.length} mounted AgentGUI windows; fresh Dock preview cache`;
  },
  summarize(prepared, result) {
    return scenarioSummary(
      [
        {
          name: `${dockPopupPreviewWindowCount} Dock popup cards rendered`,
          passed: result.cardCount === dockPopupPreviewWindowCount
        },
        {
          name: "foreground preview rendered",
          passed: result.foregroundReadyCount === 1
        },
        {
          name: "background previews rendered",
          passed:
            result.backgroundReadyCount === dockPopupPreviewWindowCount - 1
        },
        {
          name: "preview PNGs contain visible pixels",
          passed: result.pixelReadyCount === dockPopupPreviewWindowCount
        },
        {
          name: "preview titles rendered",
          passed: result.titledCardCount === dockPopupPreviewWindowCount
        },
        {
          name: "no loading or terminal fallback remained",
          passed: result.unreadyCount === 0
        },
        { name: "pixel screenshot written", passed: result.captured }
      ],
      [
        { label: "Workspace", value: prepared.workspaceID },
        { label: "Dock popup cards", value: result.cardCount },
        {
          label: "Foreground/background previews",
          value: `${result.foregroundReadyCount}/${result.backgroundReadyCount}`
        },
        { label: "Pixel-ready previews", value: result.pixelReadyCount },
        { label: "Titled cards", value: result.titledCardCount },
        { label: "Screenshot", value: dockPopupPreviewScreenshot }
      ],
      "an isolated empty preview cache forces 49 background AgentGUI cards through the serialized DOM-clone fallback; every resulting PNG must decode with visible, non-uniform pixels"
    );
  },
  assessTrace: assessWorkbenchDockPopupPreviewTrace
};

export function prepareWorkbenchDockPopupPreviewSnapshot(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.nodes)
  ) {
    throw new Error("invalid Workbench Dock popup preview snapshot input");
  }
  const stressedSnapshot = prepareAgentGUIWindowStressSnapshot(
    snapshot,
    dockPopupPreviewWindowCount
  );
  const agentGuiNodes = stressedSnapshot.nodes
    .filter((node) => node?.data?.typeId === "agent-gui")
    .map((node, index) => ({
      ...node,
      title: `Dock Preview ${index + 1}`
    }));
  const agentGuiNodeByID = new Map(
    agentGuiNodes.map((node) => [node.id, node])
  );
  return {
    snapshot: {
      ...stressedSnapshot,
      nodes: stressedSnapshot.nodes.map(
        (node) => agentGuiNodeByID.get(node.id) ?? node
      )
    },
    expectedNodeIDs: agentGuiNodes.map((node) => node.id),
    expectedTitles: agentGuiNodes.map((node) => node.title)
  };
}

export function assessWorkbenchDockPopupPreviewTrace(traceSummary) {
  const maximumRendererTaskMs = 50;
  const maximumObservedRendererTaskMs = traceSummary.timing.maxLongTaskMs;
  return {
    assertions: [
      {
        name: `renderer task <= ${maximumRendererTaskMs} ms`,
        passed: maximumObservedRendererTaskMs <= maximumRendererTaskMs
      }
    ],
    details: [
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

async function prepareWorkbenchDockPopupPreviewDatabaseSnapshot(context) {
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
  const prepared = prepareWorkbenchDockPopupPreviewSnapshot(
    JSON.parse(rows[0]?.snapshotJSON ?? "null")
  );
  await context.sqliteExec(
    context.databasePath,
    `
UPDATE workspace_workbench_snapshots
SET snapshot_json = '${sqlString(JSON.stringify(prepared.snapshot))}'
WHERE workspace_id = '${sqlString(workspaceID)}';
`
  );
  return {
    data: {
      expectedNodeIDs: prepared.expectedNodeIDs,
      workspaceID
    }
  };
}

async function prepareWorkbenchDockPopupPreview(context, options) {
  const scenarioData = requiredScenarioData(
    context,
    "workbench-dock-popup-preview"
  );
  const expectedNodeIDs = scenarioData.expectedNodeIDs;
  await waitForEvaluation(
    context.pageClient,
    `(() => {
      const expectedNodeIDs = ${JSON.stringify(expectedNodeIDs)};
      const shells = expectedNodeIDs.map((nodeID) =>
        document.querySelector('[data-workbench-window-id="' + CSS.escape(nodeID) + '"]')
      );
      const mountedShellCount = shells.filter((shell) =>
        shell instanceof HTMLElement &&
        shell.dataset.minimizedMount === 'visible' &&
        shell.dataset.presentationVisibility === 'visible'
      ).length;
      const pendingHydrationCount = document.querySelectorAll(
        '[data-agent-gui-workbench-hydration="pending"]'
      ).length;
      const slot = document.querySelector(
        '[data-desktop-dock-anchor-key="agent-gui:unified"]'
      );
      const button = slot?.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) {
        return { ready: false, mountedShellCount, pendingHydrationCount };
      }
      const rect = button.getBoundingClientRect();
      return {
        ready:
          mountedShellCount === expectedNodeIDs.length &&
          pendingHydrationCount === 0 &&
          rect.width > 0 &&
          rect.height > 0,
        mountedShellCount,
        pendingHydrationCount,
        expectedWindowCount: expectedNodeIDs.length
      };
    })()`,
    options.timeoutMs,
    "50 mounted AgentGUI windows and the unified Agent Dock button"
  );
  await waitForWorkbenchRendererQuiet(context.pageClient);
  await waitForWorkbenchRendererIdle(context.pageClient);
  return {
    expectedNodeIDs,
    workspaceID: scenarioData.workspaceID
  };
}

async function executeWorkbenchDockPopupPreview(context, prepared, options) {
  const { pageClient } = context;
  await startRendererScenario(pageClient, dockPopupPreviewMarkers.start);
  await evaluate(
    pageClient,
    `(() => {
      const slot = document.querySelector(
        '[data-desktop-dock-anchor-key="agent-gui:unified"]'
      );
      const button = slot?.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Agent Dock button is unavailable');
      }
      button.click();
      return true;
    })()`
  );
  await waitForEvaluation(
    pageClient,
    `(() => {
      const popup = document.querySelector(
        '[data-desktop-dock-popup-root][data-popup-variant="default"]'
      );
      const cards = popup?.querySelectorAll('[data-desktop-dock-popup-card]');
      return { ready: cards?.length === ${dockPopupPreviewWindowCount} };
    })()`,
    options.timeoutMs,
    "Agent Dock popup with 50 cards"
  );
  await markRenderer(pageClient, dockPopupPreviewMarkers.opened);
  await waitForEvaluation(
    pageClient,
    `(() => {
      const cards = [...document.querySelectorAll(
        '[data-desktop-dock-popup-root][data-popup-variant="default"] [data-desktop-dock-popup-card]'
      )];
      const images = cards.map((card) =>
        card.querySelector('[data-preview-state="ready"][data-preview-kind="image"] img')
      );
      return {
        ready:
          cards.length === ${dockPopupPreviewWindowCount} &&
          images.every((image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0 &&
            image.naturalHeight > 0
          )
      };
    })()`,
    options.timeoutMs,
    "decoded foreground and background Dock preview images"
  );
  const previewState = await evaluate(
    pageClient,
    `Promise.all([...document.querySelectorAll(
      '[data-desktop-dock-popup-root][data-popup-variant="default"] [data-desktop-dock-popup-card]'
    )].map(async (card) => {
      const image = card.querySelector(
        '[data-preview-state="ready"][data-preview-kind="image"] img'
      );
      if (!(image instanceof HTMLImageElement)) {
        return {
          active: card.getAttribute('data-active') === 'true',
          pixelReady: false,
          ready: false,
          title: card.querySelector('[role="button"]')?.getAttribute('aria-label') ?? ''
        };
      }
      await image.decode().catch(() => undefined);
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(64, image.naturalWidth);
      canvas.height = Math.min(64, image.naturalHeight);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Dock preview pixel canvas unavailable');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let visiblePixels = 0;
      const colorBuckets = new Set();
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] <= 8) continue;
        visiblePixels += 1;
        colorBuckets.add(
          (pixels[index] >> 5) + ':' +
          (pixels[index + 1] >> 5) + ':' +
          (pixels[index + 2] >> 5)
        );
      }
      const totalPixels = canvas.width * canvas.height;
      return {
        active: card.getAttribute('data-active') === 'true',
        pixelReady:
          totalPixels > 0 &&
          visiblePixels / totalPixels >= 0.05 &&
          colorBuckets.size >= 2,
        ready: true,
        title: card.querySelector('[role="button"]')?.getAttribute('aria-label') ?? ''
      };
    }))`,
    true
  );
  await markRenderer(pageClient, dockPopupPreviewMarkers.ready);
  await capturePageScreenshot(
    context,
    join(context.outputDirectory, dockPopupPreviewScreenshot)
  );
  await markRenderer(pageClient, dockPopupPreviewMarkers.captured);
  await finishRendererScenario(pageClient, dockPopupPreviewMarkers.end);
  return {
    backgroundReadyCount: previewState.filter(
      (preview) => !preview.active && preview.ready
    ).length,
    captured: true,
    cardCount: previewState.length,
    foregroundReadyCount: previewState.filter(
      (preview) => preview.active && preview.ready
    ).length,
    pixelReadyCount: previewState.filter((preview) => preview.pixelReady)
      .length,
    titledCardCount: previewState.filter((preview) => preview.title.trim())
      .length,
    unreadyCount: previewState.filter((preview) => !preview.ready).length
  };
}

async function capturePageScreenshot(context, outputPath) {
  const screenshot = await context.pageClient.send("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true
  });
  await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));
}

function scenarioSummary(assertions, details, stabilityCriterion) {
  return {
    outcome: assertions.every((assertion) => assertion.passed)
      ? "passed"
      : "failed",
    assertions,
    details,
    stabilityCriterion
  };
}
