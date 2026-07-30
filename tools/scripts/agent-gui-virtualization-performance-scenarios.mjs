import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clickSession,
  evaluate,
  finishRendererScenario,
  markRenderer,
  startRendererScenario,
  waitForActiveSession,
  waitForEvaluation,
  waitForStableViewport
} from "./agent-gui-performance-helpers.mjs";
import {
  enterAndSubmitComposerPrompt,
  prepareVirtualizedTranscript,
  prepareVirtualizedTranscriptSnapshot
} from "./agent-gui-layout-performance-scenarios.mjs";
import {
  scenarioSummary,
  sqlString
} from "./agent-gui-performance-snapshot-helpers.mjs";

const sessionCycleSteps = [
  ["short1", "short Session selected (round 1)"],
  ["long1", "long Session selected (round 1)"],
  ["short2", "short Session selected (round 2)"],
  ["long2", "long Session selected (round 2)"]
];
const sessionCycleMarkers = Object.fromEntries([
  ["start", "tutti-perf:virtualized-session-cycle:start"],
  ...sessionCycleSteps.map(([key]) => [
    key,
    `tutti-perf:virtualized-session-cycle:${key}-observed`
  ]),
  ["end", "tutti-perf:virtualized-session-cycle:end"]
]);

export const virtualizedSessionCycleScenario = {
  id: "virtualized-session-cycle",
  markers: sessionCycleMarkers,
  milestones: sessionCycleSteps.map(([key, label]) => ({
    key,
    label,
    marker: sessionCycleMarkers[key]
  })),
  prepareSnapshot: prepareVirtualizedSessionCycleSnapshot,
  prepare(context, options) {
    return prepareVirtualizedTranscript(
      context,
      options,
      "virtualized-session-cycle"
    );
  },
  execute: executeVirtualizedSessionCycle,
  describe(prepared) {
    return `${prepared.sessionID} ↔ ${prepared.shortSessionID}; 2 rounds`;
  },
  summarize(prepared, result) {
    return scenarioSummary(
      [
        { name: "long Session virtualized", passed: prepared.virtualized },
        {
          name: "four Session switches completed",
          passed: result.switches.length === 4
        },
        {
          name: "long Session virtualized after each return",
          passed: result.switches
            .filter((step) => step.kind === "long")
            .every((step) => step.virtualized)
        },
        {
          name: "short Session stayed non-virtualized",
          passed: result.switches
            .filter((step) => step.kind === "short")
            .every((step) => !step.virtualized)
        },
        {
          name: "returned to long Session",
          passed: result.finalSessionID === prepared.sessionID
        }
      ],
      [
        {
          label: "Session cycle",
          value: `${prepared.sessionID} ↔ ${prepared.shortSessionID}`
        },
        { label: "Rounds", value: "2" },
        { label: "Long Session turns", value: String(prepared.turnCount) },
        {
          label: "Short Session turns",
          value: String(prepared.shortTurnCount)
        },
        {
          label: "Observed modes",
          value: result.switches
            .map(
              (step) =>
                `${step.kind}:${step.virtualized ? "virtual" : "native"}`
            )
            .join(" → ")
        }
      ],
      "two long/short round trips observe the exact active Session and expected virtualization mode before each next switch"
    );
  }
};

async function prepareVirtualizedSessionCycleSnapshot(context) {
  const base = await prepareVirtualizedTranscriptSnapshot(context);
  const shortSessions = await context.sqliteJSON(
    context.databasePath,
    `
SELECT s.agent_session_id AS sessionID,
       COUNT(t.turn_id) AS turnCount
FROM workspace_agent_sessions s
LEFT JOIN workspace_agent_turns t
  ON t.workspace_id = s.workspace_id
 AND t.agent_session_id = s.agent_session_id
WHERE s.workspace_id = '${sqlString(base.data.workspaceID)}'
  AND s.agent_session_id != '${sqlString(base.data.sessionID)}'
  AND s.deleted_at_unix_ms = 0
  AND s.origin = 'WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME'
  AND s.session_kind = 'root'
GROUP BY s.agent_session_id
HAVING COUNT(t.turn_id) BETWEEN 1 AND 3
ORDER BY COUNT(t.turn_id) ASC, s.agent_session_id ASC
LIMIT 1;
`
  );
  const shortSession = shortSessions[0];
  if (!shortSession?.sessionID) {
    throw new Error(
      "virtualized-session-cycle requires one runtime root Session with one to three Turns"
    );
  }
  const now = Date.now();
  await context.sqliteExec(
    context.databasePath,
    `
UPDATE workspace_agent_sessions
SET agent_target_id = 'local:cursor',
    provider = 'cursor',
    provider_session_id = 'tutti-perf-cursor-session',
    cwd = '${sqlString(context.workspaceRoot)}',
    rail_section_kind = 'conversations',
    rail_project_path = '',
    rail_section_key = 'conversations',
    session_metadata_json = json_set(
      session_metadata_json,
      '$.visible', json('true'),
      '$.imported', json('false')
    ),
    updated_at_unix_ms = ${now}
WHERE workspace_id = '${sqlString(base.data.workspaceID)}'
  AND agent_session_id = '${sqlString(shortSession.sessionID)}';
`
  );
  return {
    data: {
      ...base.data,
      shortSessionID: shortSession.sessionID,
      shortTurnCount: Number(shortSession.turnCount)
    },
    environment: base.environment
  };
}

async function executeVirtualizedSessionCycle(context, prepared, options) {
  const { pageClient } = context;
  const steps = [
    { id: prepared.shortSessionID, kind: "short", marker: "short1" },
    { id: prepared.sessionID, kind: "long", marker: "long1" },
    { id: prepared.shortSessionID, kind: "short", marker: "short2" },
    { id: prepared.sessionID, kind: "long", marker: "long2" }
  ];
  const switches = [];
  await startRendererScenario(pageClient, sessionCycleMarkers.start);
  for (const step of steps) {
    await clickSession(pageClient, step.id);
    await waitForActiveSession(pageClient, step.id, options.timeoutMs);
    const observed = await waitForEvaluation(
      pageClient,
      `(() => {
        const timeline = document.querySelector('[data-testid="agent-gui-timeline"]');
        const virtualized = Boolean(timeline?.querySelector('[data-agent-transcript-virtualized="true"]'));
        return {
          ready: Boolean(timeline) && virtualized === ${step.kind === "long"},
          scrollTop: timeline instanceof HTMLElement ? timeline.scrollTop : -1,
          virtualized
        };
      })()`,
      options.timeoutMs,
      `${step.kind} Session virtualization mode`
    );
    switches.push({
      kind: step.kind,
      scrollTop: observed.scrollTop,
      virtualized: observed.virtualized
    });
    await markRenderer(pageClient, sessionCycleMarkers[step.marker]);
  }
  await finishRendererScenario(pageClient, sessionCycleMarkers.end);
  return {
    finalSessionID: prepared.sessionID,
    switches
  };
}

const oversizedMarkers = {
  start: "tutti-perf:virtualized-oversized-active-turn:start",
  working: "tutti-perf:virtualized-oversized-active-turn:working-observed",
  oversized: "tutti-perf:virtualized-oversized-active-turn:oversized-observed",
  stable: "tutti-perf:virtualized-oversized-active-turn:stable-observed",
  end: "tutti-perf:virtualized-oversized-active-turn:end"
};

export const virtualizedOversizedActiveTurnScenario = {
  id: "virtualized-oversized-active-turn",
  markers: oversizedMarkers,
  milestones: [
    {
      key: "working",
      label: "active Turn started",
      marker: oversizedMarkers.working
    },
    {
      key: "oversized",
      label: "oversized active Turn observed",
      marker: oversizedMarkers.oversized
    },
    {
      key: "stable",
      label: "oversized viewport stable",
      marker: oversizedMarkers.stable
    }
  ],
  prepareSnapshot: prepareOversizedActiveTurnSnapshot,
  prepare(context, options) {
    return prepareVirtualizedTranscript(
      context,
      options,
      "virtualized-oversized-active-turn"
    );
  },
  execute: executeOversizedActiveTurn,
  describe(prepared) {
    return `${prepared.sessionID}; 18 persisted Turns + one active Turn; ~${prepared.targetToolCallCount} tool calls`;
  },
  summarize(prepared, result) {
    return scenarioSummary(
      [
        { name: "transcript virtualized", passed: prepared.virtualized },
        { name: "active Turn stayed running", passed: result.working },
        {
          name: "fixture reached nineteen Turns",
          passed: prepared.persistedTurnCount + 1 === 19
        },
        {
          name: "fixture reached approximately 250 tool calls",
          passed: prepared.targetToolCallCount >= 240
        },
        {
          name: "active Turn has at least forty tool calls",
          passed: result.activeToolCallCount >= 40
        },
        {
          name: "virtualizer kept a bounded Turn window",
          passed:
            result.mountedTurnCount > 0 &&
            result.mountedTurnCount < prepared.persistedTurnCount + 1
        }
      ],
      [
        { label: "Session", value: prepared.sessionID },
        {
          label: "Turns",
          value: `${prepared.persistedTurnCount} persisted + 1 active`
        },
        {
          label: "Tool calls",
          value: `${prepared.persistedToolCallCount} persisted + ${prepared.streamedToolCallCount} active`
        },
        {
          label: "Mounted virtual Turns / transcript rows",
          value: `${result.mountedTurnCount} / ${result.mountedRowCount}`
        },
        {
          label: "Active Turn tool calls",
          value: String(result.activeToolCallCount)
        },
        {
          label: "Mutation batches / records",
          value: `${result.mutationBatches} / ${result.mutations}`
        }
      ],
      "the trace ends while the nineteenth Turn is still active, after its grouped tool-call count reaches the deterministic fixture target and the viewport settles"
    );
  }
};

async function prepareOversizedActiveTurnSnapshot(context) {
  const base = await prepareVirtualizedTranscriptSnapshot(context);
  await context.sqliteExec(
    context.databasePath,
    `
PRAGMA foreign_keys = ON;
DELETE FROM workspace_agent_messages
WHERE workspace_id = '${sqlString(base.data.workspaceID)}'
  AND agent_session_id = '${sqlString(base.data.sessionID)}'
  AND turn_id IN (
    SELECT turn_id
    FROM workspace_agent_turns
    WHERE workspace_id = '${sqlString(base.data.workspaceID)}'
      AND agent_session_id = '${sqlString(base.data.sessionID)}'
    ORDER BY started_at_unix_ms DESC, turn_id DESC
    LIMIT -1 OFFSET 18
  );
DELETE FROM workspace_agent_turns
WHERE workspace_id = '${sqlString(base.data.workspaceID)}'
  AND agent_session_id = '${sqlString(base.data.sessionID)}'
  AND turn_id IN (
    SELECT turn_id
    FROM workspace_agent_turns
    WHERE workspace_id = '${sqlString(base.data.workspaceID)}'
      AND agent_session_id = '${sqlString(base.data.sessionID)}'
    ORDER BY started_at_unix_ms DESC, turn_id DESC
    LIMIT -1 OFFSET 18
  );
`
  );
  const counts = await context.sqliteJSON(
    context.databasePath,
    `
SELECT
  (
    SELECT COUNT(*)
    FROM workspace_agent_turns
    WHERE workspace_id = '${sqlString(base.data.workspaceID)}'
      AND agent_session_id = '${sqlString(base.data.sessionID)}'
  ) AS turnCount,
  (
    SELECT COUNT(*)
    FROM workspace_agent_messages
    WHERE workspace_id = '${sqlString(base.data.workspaceID)}'
      AND agent_session_id = '${sqlString(base.data.sessionID)}'
      AND deleted_at_unix_ms = 0
      AND kind = 'tool_call'
  ) AS toolCallCount;
`
  );
  const persistedTurnCount = Number(counts[0]?.turnCount ?? 0);
  const persistedToolCallCount = Number(counts[0]?.toolCallCount ?? 0);
  if (persistedTurnCount !== 18) {
    throw new Error(
      `virtualized-oversized-active-turn retained ${persistedTurnCount} Turns, expected 18`
    );
  }
  const streamedToolCallCount = Math.max(40, 250 - persistedToolCallCount);
  return {
    data: {
      ...base.data,
      persistedToolCallCount,
      persistedTurnCount,
      streamedToolCallCount,
      targetToolCallCount: persistedToolCallCount + streamedToolCallCount,
      turnCount: persistedTurnCount
    },
    environment: {
      ...base.environment,
      TUTTI_PERF_OVERSIZED_TOOL_CALLS: String(streamedToolCallCount)
    }
  };
}

async function executeOversizedActiveTurn(context, prepared, options) {
  const { pageClient } = context;
  await evaluate(
    pageClient,
    `(() => {
      const root = document.querySelector('[data-agent-transcript-virtualized="true"]');
      if (!(root instanceof HTMLElement)) throw new Error('virtualized transcript is unavailable');
      const state = window.__tuttiPerfOversizedActiveTurn = {
        mutationBatches: 0,
        mutations: 0
      };
      state.observer = new MutationObserver((records) => {
        state.mutationBatches += 1;
        state.mutations += records.length;
      });
      state.observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
      });
      return true;
    })()`
  );
  await startRendererScenario(pageClient, oversizedMarkers.start);
  await enterAndSubmitComposerPrompt(
    pageClient,
    "Render oversized active Turn performance fixture",
    options.timeoutMs
  );
  await waitForEvaluation(
    pageClient,
    `({ ready: Boolean(document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]')) })`,
    options.timeoutMs,
    "oversized fixture working state"
  );
  await markRenderer(pageClient, oversizedMarkers.working);
  const oversized = await waitForEvaluation(
    pageClient,
    `(() => {
      const labels = [...document.querySelectorAll('.workspace-agents-status-panel__detail-tool-count-primary')];
      const counts = labels
        .map((label) => Number((label.textContent ?? '').match(/\\d+/u)?.[0] ?? 0))
        .filter((count) => Number.isFinite(count));
      const activeToolCallCount = Math.max(0, ...counts);
      const root = document.querySelector('[data-agent-transcript-virtualized="true"]');
      const working = Boolean(document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]'));
      return {
        ready: Boolean(root && working && activeToolCallCount >= ${prepared.streamedToolCallCount}),
        activeToolCallCount,
        mountedRowCount: root?.querySelectorAll('[data-agent-transcript-row]').length ?? 0,
        mountedTurnCount: root?.querySelectorAll('[data-agent-transcript-virtual-turn]').length ?? 0,
        working
      };
    })()`,
    options.timeoutMs,
    "oversized active Turn tool calls",
    25
  );
  await markRenderer(pageClient, oversizedMarkers.oversized);
  await waitForStableViewport(pageClient, options.timeoutMs);
  await markRenderer(pageClient, oversizedMarkers.stable);
  const mutations = await evaluate(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfOversizedActiveTurn;
      state?.observer?.disconnect();
      return {
        mutationBatches: state?.mutationBatches ?? 0,
        mutations: state?.mutations ?? 0
      };
    })()`
  );
  await finishRendererScenario(pageClient, oversizedMarkers.end);
  return { ...oversized, ...mutations };
}

const browserPixelsMarkers = {
  start: "tutti-perf:browser-behind-agent-gui-pixels:start",
  scrolled: "tutti-perf:browser-behind-agent-gui-pixels:scrolled-observed",
  captured: "tutti-perf:browser-behind-agent-gui-pixels:captured-observed",
  end: "tutti-perf:browser-behind-agent-gui-pixels:end"
};
const browserReferenceScreenshot = "browser-reference.png";
const browserBehindAgentScreenshot = "browser-behind-agent-gui.png";

export const browserBehindAgentGUIPixelsScenario = {
  id: "browser-behind-agent-gui-pixels",
  markers: browserPixelsMarkers,
  milestones: [
    {
      key: "scrolled",
      label: "virtualized AgentGUI scrolled",
      marker: browserPixelsMarkers.scrolled
    },
    {
      key: "captured",
      label: "composited pixels captured",
      marker: browserPixelsMarkers.captured
    }
  ],
  prepareSnapshot: prepareVirtualizedTranscriptSnapshot,
  prepare: prepareBrowserBehindAgentGUIPixels,
  execute: executeBrowserBehindAgentGUIPixels,
  describe(prepared) {
    return `${prepared.sessionID}; Browser ${prepared.browserNodeID} behind fullscreen AgentGUI ${prepared.agentNodeID}`;
  },
  summarize(prepared, result) {
    return scenarioSummary(
      [
        { name: "transcript virtualized", passed: prepared.virtualized },
        { name: "Browser webview mounted", passed: prepared.browserReady },
        { name: "AgentGUI covered Browser", passed: result.agentFullscreen },
        { name: "virtualized transcript scrolled", passed: result.scrolled },
        {
          name: "both pixel captures written",
          passed: result.referenceCaptured && result.coveredCaptured
        }
      ],
      [
        { label: "Session", value: prepared.sessionID },
        {
          label: "Browser reference pixels",
          value: browserReferenceScreenshot
        },
        {
          label: "Browser behind AgentGUI pixels",
          value: browserBehindAgentScreenshot
        },
        {
          label: "Pixel verdict",
          value: "manual inspection required; DOM state is not a pixel proof"
        }
      ],
      "a high-contrast Browser webview is captured first, then remains mounted behind a fullscreen virtualized AgentGUI while the transcript scrolls and a second composited screenshot is captured"
    );
  }
};

async function prepareBrowserBehindAgentGUIPixels(context, options) {
  const prepared = await prepareVirtualizedTranscript(
    context,
    options,
    "browser-behind-agent-gui-pixels"
  );
  const browser = await waitForEvaluation(
    context.pageClient,
    `(() => {
      const slot = document.querySelector('[data-desktop-dock-anchor-key="browser"]');
      const button = slot?.querySelector('button');
      const existing = document.querySelector('[data-workbench-node-type-id="browser"]');
      if (!existing && button instanceof HTMLButtonElement) button.click();
      const shell = document.querySelector('[data-workbench-node-type-id="browser"]');
      const webview = shell?.querySelector('webview');
      return {
        ready: Boolean(shell && webview),
        browserNodeID: shell?.getAttribute('data-workbench-window-id') ?? ''
      };
    })()`,
    options.timeoutMs,
    "Browser Workbench webview"
  );
  const fixtureURL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      "<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:repeating-linear-gradient(45deg,#ff00ff 0 80px,#00ff66 80px 160px);color:#000;font:700 72px sans-serif}body{display:grid;place-items:center}</style><body>BROWSER PIXELS</body>"
    );
  await evaluate(
    context.pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${browser.browserNodeID}"]`)});
      const webview = shell?.querySelector('webview');
      if (!webview || typeof webview.loadURL !== 'function') {
        throw new Error('Browser webview loadURL is unavailable');
      }
      void webview.loadURL(${JSON.stringify(fixtureURL)});
      return true;
    })()`
  );
  await waitForEvaluation(
    context.pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${browser.browserNodeID}"]`)});
      const webview = shell?.querySelector('webview');
      return {
        ready: Boolean(webview && typeof webview.getURL === 'function' && webview.getURL().startsWith('data:text/html'))
      };
    })()`,
    options.timeoutMs,
    "high-contrast Browser fixture"
  );
  await waitForEvaluation(
    context.pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${browser.browserNodeID}"]`)});
      const fullscreen = shell?.querySelector(
        '[data-workspace-workbench-traffic-light="maximize"]'
      );
      return {
        ready: shell instanceof HTMLElement && fullscreen instanceof HTMLButtonElement
      };
    })()`,
    options.timeoutMs,
    "Browser fullscreen control"
  );
  await evaluate(
    context.pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${browser.browserNodeID}"]`)});
      const fullscreen = shell?.querySelector(
        '[data-workspace-workbench-traffic-light="maximize"]'
      );
      if (!(shell instanceof HTMLElement) || !(fullscreen instanceof HTMLButtonElement)) {
        throw new Error('Browser fullscreen control is unavailable');
      }
      shell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      if (shell.dataset.displayMode !== 'fullscreen') fullscreen.click();
      return true;
    })()`
  );
  await waitForEvaluation(
    context.pageClient,
    `(() => {
      const shell = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${browser.browserNodeID}"]`)});
      return {
        ready: shell?.getAttribute('data-display-mode') === 'fullscreen' &&
          shell?.getAttribute('data-focused') === 'true'
      };
    })()`,
    options.timeoutMs,
    "fullscreen Browser reference"
  );
  await capturePageScreenshot(
    context,
    join(context.outputDirectory, browserReferenceScreenshot)
  );
  const agent = await waitForEvaluation(
    context.pageClient,
    `(() => {
      const shell = Array.from(
        document.querySelectorAll('[data-workbench-node-type-id="agent-gui"]')
      ).find((candidate) =>
        candidate.querySelector('[data-agent-transcript-virtualized="true"]')
      );
      if (!(shell instanceof HTMLElement)) return { ready: false };
      shell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      const fullscreen = shell.querySelector(
        '[data-agent-gui-workbench-traffic-light="maximize"]'
      );
      if (shell.dataset.displayMode !== 'fullscreen' && fullscreen instanceof HTMLButtonElement) {
        fullscreen.click();
      }
      return {
        ready: fullscreen instanceof HTMLButtonElement,
        agentNodeID: shell.dataset.workbenchWindowId ?? ''
      };
    })()`,
    options.timeoutMs,
    "focused AgentGUI Workbench window"
  );
  await waitForEvaluation(
    context.pageClient,
    `(() => {
      const agent = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${agent.agentNodeID}"]`)});
      const browser = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${browser.browserNodeID}"]`)});
      return {
        ready: Boolean(
          agent?.getAttribute('data-display-mode') === 'fullscreen' &&
          agent.querySelector('[data-agent-transcript-virtualized="true"]') &&
          browser?.querySelector('webview')
        )
      };
    })()`,
    options.timeoutMs,
    "Browser behind fullscreen virtualized AgentGUI"
  );
  return {
    ...prepared,
    agentNodeID: agent.agentNodeID,
    browserNodeID: browser.browserNodeID,
    browserReady: true
  };
}

async function executeBrowserBehindAgentGUIPixels(context, prepared, options) {
  await startRendererScenario(context.pageClient, browserPixelsMarkers.start);
  const scroll = await evaluate(
    context.pageClient,
    `new Promise((resolve) => {
      const timeline = document.querySelector('[data-testid="agent-gui-timeline"]');
      if (!(timeline instanceof HTMLElement)) throw new Error('timeline is unavailable');
      const start = timeline.scrollTop;
      const target = start - timeline.clientHeight * 3;
      const startedAt = performance.now();
      const step = () => {
        const progress = Math.min((performance.now() - startedAt) / 800, 1);
        timeline.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
        timeline.scrollTop = start + (target - start) * progress;
        if (progress < 1) {
          requestAnimationFrame(step);
          return;
        }
        requestAnimationFrame(() => resolve({
          end: timeline.scrollTop,
          start
        }));
      };
      requestAnimationFrame(step);
    })`,
    true
  );
  await markRenderer(context.pageClient, browserPixelsMarkers.scrolled);
  await waitForStableViewport(context.pageClient, options.timeoutMs);
  await capturePageScreenshot(
    context,
    join(context.outputDirectory, browserBehindAgentScreenshot)
  );
  await markRenderer(context.pageClient, browserPixelsMarkers.captured);
  const state = await evaluate(
    context.pageClient,
    `(() => {
      const agent = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.agentNodeID}"]`)});
      const browser = document.querySelector(${JSON.stringify(`[data-workbench-window-id="${prepared.browserNodeID}"]`)});
      return {
        agentFullscreen: agent?.getAttribute('data-display-mode') === 'fullscreen',
        browserMounted: Boolean(browser?.querySelector('webview'))
      };
    })()`
  );
  await finishRendererScenario(context.pageClient, browserPixelsMarkers.end);
  return {
    ...state,
    coveredCaptured: true,
    referenceCaptured: true,
    scrolled: scroll.end < scroll.start
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
