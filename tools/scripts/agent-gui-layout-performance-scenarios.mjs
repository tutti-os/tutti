import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clickAgentWindowControl,
  clickProviderTarget,
  clickSession,
  evaluate,
  finishRendererScenario,
  markRenderer,
  selectProvider,
  startRendererScenario,
  waitForActiveSession,
  waitForAgentWorkbenchWindow,
  waitForEvaluation,
  waitForProviderTiles,
  waitForSelectedTarget,
  waitForStableAgentWorkbenchWindow,
  waitForStableRail,
  waitForStableViewport
} from "./agent-gui-performance-helpers.mjs";
import {
  requiredScenarioData,
  scenarioSummary as summary,
  sqlString,
  startupWorkspaceID,
  updateAgentGUISnapshot
} from "./agent-gui-performance-snapshot-helpers.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cursorFixtureDirectory = join(
  scriptDirectory,
  "fixtures",
  "agent-gui-performance"
);
const conversationItemPrefix = "agent-gui-conversation-item-";

const virtualizedStreamingMarkers = {
  start: "tutti-perf:virtualized-streaming:start",
  submitted: "tutti-perf:virtualized-streaming:submitted-observed",
  firstMutation: "tutti-perf:virtualized-streaming:first-mutation-observed",
  settled: "tutti-perf:virtualized-streaming:settled-observed",
  end: "tutti-perf:virtualized-streaming:end"
};

export const virtualizedStreamingScenario = {
  id: "virtualized-streaming",
  markers: virtualizedStreamingMarkers,
  milestones: [
    {
      key: "submitted",
      label: "fixture prompt submitted",
      marker: virtualizedStreamingMarkers.submitted
    },
    {
      key: "firstMutation",
      label: "first virtualized transcript mutation",
      marker: virtualizedStreamingMarkers.firstMutation
    },
    {
      key: "settled",
      label: "streaming fixture settled",
      marker: virtualizedStreamingMarkers.settled
    }
  ],
  prepareSnapshot: prepareVirtualizedTranscriptSnapshot,
  prepare: prepareVirtualizedStreaming,
  execute: executeVirtualizedStreaming,
  describe(prepared) {
    return `${prepared.sessionID}; ${prepared.turnCount} persisted turns + deterministic ACP stream`;
  },
  summarize(prepared, result) {
    return summary(
      [
        {
          name: "transcript virtualized before stream",
          passed: prepared.virtualized
        },
        {
          name: "stream entered working state",
          passed: result.started
        },
        {
          name: "virtualizer DOM mutated repeatedly",
          passed: result.mutationBatches >= 8
        },
        {
          name: "transcript remained virtualized",
          passed: result.virtualizedAfter
        },
        { name: "stream settled", passed: result.settled }
      ],
      [
        { label: "Session", value: prepared.sessionID },
        { label: "Persisted turns", value: String(prepared.turnCount) },
        { label: "Mutation batches", value: String(result.mutationBatches) },
        { label: "DOM mutations", value: String(result.mutations) },
        { label: "Provider", value: "isolated fake Cursor ACP" }
      ],
      "virtualized DOM is observed before submit; deterministic local ACP chunks produce at least eight MutationObserver batches; working state settles before the trace tail"
    );
  }
};

export async function prepareVirtualizedTranscriptSnapshot(
  context,
  options = {}
) {
  const fixtureBinDirectory = join(context.runtimeDirectory, "state", "bin");
  await mkdir(fixtureBinDirectory, { recursive: true });
  const fixtureBinaryPath = join(fixtureBinDirectory, "cursor-agent");
  await copyFile(
    join(cursorFixtureDirectory, "cursor-agent"),
    fixtureBinaryPath
  );
  await chmod(fixtureBinaryPath, 0o755);
  const workspaceID = await startupWorkspaceID(context);
  const richTextCandidateRequirement = options.richTextFixture
    ? "AND userTextMessageCount >= 4"
    : "";
  const candidates = await context.sqliteJSON(
    context.databasePath,
    `
SELECT s.agent_session_id AS sessionID,
       COUNT(t.turn_id) AS turnCount,
       (
         SELECT COUNT(*)
         FROM workspace_agent_messages m
         WHERE m.workspace_id = s.workspace_id
           AND m.agent_session_id = s.agent_session_id
           AND m.deleted_at_unix_ms = 0
           AND m.role = 'user'
           AND m.kind = 'text'
       ) AS userTextMessageCount
FROM workspace_agent_sessions s
JOIN workspace_agent_turns t
  ON t.workspace_id = s.workspace_id
 AND t.agent_session_id = s.agent_session_id
WHERE s.workspace_id = '${sqlString(workspaceID)}'
  AND s.deleted_at_unix_ms = 0
  AND s.session_kind = 'root'
  AND s.active_turn_id IS NULL
GROUP BY s.agent_session_id
HAVING COUNT(t.turn_id) >= 30
  ${richTextCandidateRequirement}
ORDER BY COUNT(t.turn_id) ASC, s.agent_session_id ASC
LIMIT 1;
`
  );
  const candidate = candidates[0];
  if (!candidate?.sessionID) {
    throw new Error(
      options.richTextFixture
        ? "virtualized-scroll-locator requires one root session with at least 30 settled turns and four user text messages in the source snapshot"
        : "virtualized-streaming requires one root session with at least 30 settled turns in the source snapshot"
    );
  }
  const now = Date.now();
  const fixtureMention = `[@Cursor](mention://agent-target/local%3Acursor?workspaceId=${encodeURIComponent(workspaceID)})`;
  const richTextFixture = [
    "Virtualized transcript performance fixture",
    `${fixtureMention} inspect the historical scroll anchor and preserve the visible turn`,
    "Paragraph three contains enough deterministic text to produce stable wrapping across narrow and wide transcript viewports",
    "Paragraph four exercises static rich-text document creation without mounting an editable ProseMirror view",
    `${fixtureMention} compare the current viewport with the message locator while older turns enter the virtual window`,
    "Paragraph six keeps each historical user message tall enough to sustain a long monotonic upward scroll",
    "Paragraph seven verifies that repeated line boundaries remain static while the virtualizer replaces mounted turns",
    `${fixtureMention} finish the fixture with a third mention chip and a final wrapped paragraph`
  ].join("\n");
  const richTextFixtureUpdate = options.richTextFixture
    ? `UPDATE workspace_agent_messages
SET payload_json = json_set(
      payload_json,
      '$.text',
      '${sqlString(richTextFixture)}'
    ),
    updated_at_unix_ms = ${now}
WHERE workspace_id = '${sqlString(workspaceID)}'
  AND agent_session_id = '${sqlString(candidate.sessionID)}'
  AND deleted_at_unix_ms = 0
  AND role = 'user'
  AND kind = 'text';`
    : "";
  await context.sqliteExec(
    context.databasePath,
    `
PRAGMA foreign_keys = ON;
UPDATE agent_targets
SET enabled = 1, updated_at_ms = ${now}
WHERE id = 'local:cursor';
UPDATE workspace_agent_sessions
SET agent_target_id = 'local:cursor',
    provider = 'cursor',
    provider_session_id = 'tutti-perf-cursor-session',
    model = '',
    settings_json = '{}',
    cwd = '${sqlString(context.workspaceRoot)}',
    rail_section_kind = 'project',
    rail_project_path = '${sqlString(context.workspaceRoot)}',
    rail_section_key = 'project:${sqlString(context.workspaceRoot)}',
    session_metadata_json = json_set(
      session_metadata_json,
      '$.visible', json('true'),
      '$.imported', json('false')
    ),
    internal_runtime_context_json = '{}',
    updated_at_unix_ms = ${now}
WHERE workspace_id = '${sqlString(workspaceID)}'
  AND agent_session_id = '${sqlString(candidate.sessionID)}';
${richTextFixtureUpdate}
`
  );
  return {
    data: {
      sessionID: candidate.sessionID,
      turnCount: Number(candidate.turnCount),
      richTextMessageCount: Number(candidate.userTextMessageCount),
      richTextMentionsPerMessage: options.richTextFixture ? 3 : 0,
      richTextParagraphsPerMessage: options.richTextFixture ? 8 : 0,
      workspaceID
    },
    environment: {
      PATH: `${fixtureBinDirectory}:${process.env.PATH ?? ""}`,
      SHELL: fixtureBinaryPath
    }
  };
}

async function prepareVirtualizedStreaming(context, options) {
  return prepareVirtualizedTranscript(
    context,
    options,
    "virtualized-streaming"
  );
}

export async function prepareVirtualizedTranscript(
  context,
  options,
  scenarioID
) {
  const fixture = requiredScenarioData(context, scenarioID);
  const providers = await waitForProviderTiles(
    context.pageClient,
    options.timeoutMs
  );
  if (
    !providers.tiles.some(
      (tile) => tile.targetID === "local:cursor" && !tile.disabled
    )
  ) {
    throw new Error(
      `enabled local:cursor target is unavailable; visible targets: ${providers.tiles.map((tile) => `${tile.targetID}${tile.disabled ? " (disabled)" : ""}`).join(", ")}`
    );
  }
  await selectProvider(context.pageClient, "local:cursor", options.timeoutMs);
  await clickSession(context.pageClient, fixture.sessionID);
  await waitForActiveSession(
    context.pageClient,
    fixture.sessionID,
    options.timeoutMs
  );
  const transcript = await waitForEvaluation(
    context.pageClient,
    `(() => {
      const timeline = document.querySelector('[data-testid="agent-gui-timeline"]');
      const virtualized = timeline?.querySelector('[data-agent-transcript-virtualized="true"]');
      const editor = document.querySelector('#agent-gui-detail [contenteditable="true"][role="textbox"]');
      return {
        ready: Boolean(timeline && virtualized && editor && editor.getAttribute('aria-disabled') !== 'true'),
        virtualized: Boolean(virtualized)
      };
    })()`,
    options.timeoutMs,
    "virtualized transcript and enabled composer"
  );
  return { ...fixture, virtualized: transcript.virtualized };
}

async function executeVirtualizedStreaming(context, _prepared, options) {
  const { pageClient } = context;
  await evaluate(
    pageClient,
    `(() => {
      const root = document.querySelector('[data-agent-transcript-virtualized="true"]');
      if (!(root instanceof HTMLElement)) throw new Error('virtualized transcript is unavailable');
      const state = window.__tuttiPerfVirtualizedStreaming = {
        firstMutationMarked: false,
        mutationBatches: 0,
        mutations: 0
      };
      state.observer = new MutationObserver((records) => {
        state.mutationBatches += 1;
        state.mutations += records.length;
        if (!state.firstMutationMarked) {
          state.firstMutationMarked = true;
          console.timeStamp(${JSON.stringify(virtualizedStreamingMarkers.firstMutation)});
        }
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
  await startRendererScenario(pageClient, virtualizedStreamingMarkers.start);
  await enterAndSubmitComposerPrompt(
    pageClient,
    "Render deterministic virtualized streaming performance fixture",
    options.timeoutMs
  );
  const started = await waitForEvaluation(
    pageClient,
    `({ ready: Boolean(document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]')) })`,
    options.timeoutMs,
    "streaming fixture working state"
  );
  await markRenderer(pageClient, virtualizedStreamingMarkers.submitted);
  const settled = await waitForEvaluation(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfVirtualizedStreaming;
      return {
        ready: Boolean(state?.firstMutationMarked && state.mutationBatches >= 8 && !document.querySelector('[data-testid="agent-gui-composer-stop-symbol"]')),
        mutationBatches: state?.mutationBatches ?? 0,
        mutations: state?.mutations ?? 0,
        virtualizedAfter: Boolean(document.querySelector('[data-agent-transcript-virtualized="true"]'))
      };
    })()`,
    options.timeoutMs,
    "settled virtualized streaming fixture",
    50
  );
  await markRenderer(pageClient, virtualizedStreamingMarkers.settled);
  await evaluate(
    pageClient,
    `(() => {
      window.__tuttiPerfVirtualizedStreaming?.observer?.disconnect();
      return true;
    })()`
  );
  await finishRendererScenario(pageClient, virtualizedStreamingMarkers.end);
  return {
    mutationBatches: settled.mutationBatches,
    mutations: settled.mutations,
    settled: settled.ready,
    started: started.ready,
    virtualizedAfter: settled.virtualizedAfter
  };
}

const railRevealMarkers = {
  start: "tutti-perf:rail-scope-reveal:start",
  selected: "tutti-perf:rail-scope-reveal:selected-observed",
  revealed: "tutti-perf:rail-scope-reveal:scroll-into-view-observed",
  stable: "tutti-perf:rail-scope-reveal:stable-observed",
  end: "tutti-perf:rail-scope-reveal:end"
};

export const railScopeRevealScenario = {
  id: "rail-scope-reveal",
  markers: railRevealMarkers,
  milestones: [
    {
      key: "selected",
      label: "target Agent scope selected",
      marker: railRevealMarkers.selected
    },
    {
      key: "revealed",
      label: "active session scrollIntoView",
      marker: railRevealMarkers.revealed
    },
    {
      key: "stable",
      label: "target rail stable",
      marker: railRevealMarkers.stable
    }
  ],
  prepareSnapshot: prepareRailScopeRevealSnapshot,
  prepare: prepareRailScopeReveal,
  execute: executeRailScopeReveal,
  describe(prepared) {
    return `${prepared.sourceTargetID} -> ${prepared.targetTargetID}; reveal ${prepared.sessionID}`;
  },
  summarize(prepared, result) {
    return summary(
      [
        { name: "target Agent selected", passed: result.selected },
        { name: "target session active", passed: result.active },
        {
          name: "target session received scrollIntoView",
          passed: result.revealCalls > 0
        },
        { name: "rail stable", passed: result.stable }
      ],
      [
        {
          label: "Agent scope",
          value: `${prepared.sourceTargetID} → ${prepared.targetTargetID}`
        },
        { label: "Session", value: prepared.sessionID },
        { label: "scrollIntoView calls", value: String(result.revealCalls) }
      ],
      "a fresh Agent scope restores its mapped active session; the scenario records the exact target row scrollIntoView call before waiting for five stable rail snapshots"
    );
  }
};

async function prepareRailScopeRevealSnapshot(context) {
  const workspaceID = await startupWorkspaceID(context);
  const targets = await context.sqliteJSON(
    context.databasePath,
    `
SELECT agent_target_id AS targetID, COUNT(*) AS sessionCount
FROM workspace_agent_sessions
WHERE workspace_id = '${sqlString(workspaceID)}'
  AND deleted_at_unix_ms = 0
  AND agent_target_id IS NOT NULL
GROUP BY agent_target_id
HAVING COUNT(*) >= 2
ORDER BY COUNT(*) DESC, agent_target_id ASC
LIMIT 2;
`
  );
  if (targets.length < 2) {
    throw new Error(
      "rail-scope-reveal requires sessions for at least two Agent targets"
    );
  }
  const targetTargetID = targets[0].targetID;
  const sourceTargetID = targets[1].targetID;
  const sessions = await context.sqliteJSON(
    context.databasePath,
    `
SELECT agent_session_id AS sessionID
FROM workspace_agent_sessions
WHERE workspace_id = '${sqlString(workspaceID)}'
  AND agent_target_id = '${sqlString(targetTargetID)}'
  AND deleted_at_unix_ms = 0
ORDER BY updated_at_unix_ms DESC, agent_session_id ASC
LIMIT 1 OFFSET 4;
`
  );
  const sessionID = sessions[0]?.sessionID;
  if (!sessionID) {
    throw new Error(
      "rail-scope-reveal could not select a fifth target session"
    );
  }
  await updateAgentGUISnapshot(context, (state) => ({
    ...state,
    agentTargetId: sourceTargetID,
    lastActiveAgentSessionId: null,
    lastActiveAgentSessionIdByAgentTargetId: {
      ...(state.lastActiveAgentSessionIdByAgentTargetId ?? {}),
      [targetTargetID]: sessionID
    }
  }));
  return {
    data: { sessionID, sourceTargetID, targetTargetID, workspaceID }
  };
}

async function prepareRailScopeReveal(context, options) {
  const fixture = requiredScenarioData(context, "rail-scope-reveal");
  const providers = await waitForProviderTiles(
    context.pageClient,
    options.timeoutMs
  );
  const available = new Set(
    providers.tiles
      .filter((tile) => tile.disabled !== true)
      .map((tile) => tile.targetID)
  );
  if (
    !available.has(fixture.sourceTargetID) ||
    !available.has(fixture.targetTargetID)
  ) {
    throw new Error(
      `rail-scope-reveal requires enabled targets ${fixture.sourceTargetID} and ${fixture.targetTargetID}`
    );
  }
  if (providers.selectedTargetID !== fixture.sourceTargetID) {
    await selectProvider(
      context.pageClient,
      fixture.sourceTargetID,
      options.timeoutMs
    );
  } else {
    await waitForStableRail(
      context.pageClient,
      fixture.sourceTargetID,
      options.timeoutMs
    );
  }
  return fixture;
}

async function executeRailScopeReveal(context, prepared, options) {
  const { pageClient } = context;
  await evaluate(
    pageClient,
    `(() => {
      const original = Element.prototype.scrollIntoView;
      window.__tuttiPerfRailReveal = { calls: [], original };
      Element.prototype.scrollIntoView = function(options) {
        const testID = this instanceof HTMLElement ? (this.dataset.testid ?? '') : '';
        window.__tuttiPerfRailReveal.calls.push({ options, testID });
        return original.call(this, options);
      };
      return true;
    })()`
  );
  await startRendererScenario(pageClient, railRevealMarkers.start);
  await clickProviderTarget(pageClient, prepared.targetTargetID);
  const selected = await waitForSelectedTarget(
    pageClient,
    prepared.targetTargetID,
    options.timeoutMs
  );
  await markRenderer(pageClient, railRevealMarkers.selected);
  const active = await waitForActiveSession(
    pageClient,
    prepared.sessionID,
    options.timeoutMs
  );
  const revealed = await waitForEvaluation(
    pageClient,
    `(() => {
      const testID = ${JSON.stringify(conversationItemPrefix)} + ${JSON.stringify(prepared.sessionID)};
      const calls = window.__tuttiPerfRailReveal?.calls ?? [];
      return { ready: calls.some((call) => call.testID === testID), revealCalls: calls.filter((call) => call.testID === testID).length };
    })()`,
    options.timeoutMs,
    `scrollIntoView for ${prepared.sessionID}`,
    50
  );
  await markRenderer(pageClient, railRevealMarkers.revealed);
  const stable = await waitForStableRail(
    pageClient,
    prepared.targetTargetID,
    options.timeoutMs
  );
  await markRenderer(pageClient, railRevealMarkers.stable);
  await evaluate(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfRailReveal;
      if (state?.original) Element.prototype.scrollIntoView = state.original;
      return true;
    })()`
  );
  await finishRendererScenario(pageClient, railRevealMarkers.end);
  return {
    active: active.ready,
    revealCalls: revealed.revealCalls,
    selected: selected.ready,
    stable: stable.sectionCount > 0
  };
}

const composerResizeMarkers = {
  start: "tutti-perf:composer-overflow-resize:start",
  narrowed: "tutti-perf:composer-overflow-resize:narrowed-observed",
  overflowing: "tutti-perf:composer-overflow-resize:overflow-observed",
  restored: "tutti-perf:composer-overflow-resize:restored-observed",
  end: "tutti-perf:composer-overflow-resize:end"
};

export const composerOverflowResizeScenario = {
  id: "composer-overflow-resize",
  markers: composerResizeMarkers,
  milestones: [
    {
      key: "narrowed",
      label: "renderer viewport narrowed",
      marker: composerResizeMarkers.narrowed
    },
    {
      key: "overflowing",
      label: "prompt tip layout measurement observed",
      marker: composerResizeMarkers.overflowing
    },
    {
      key: "restored",
      label: "renderer viewport restored",
      marker: composerResizeMarkers.restored
    }
  ],
  prepare: prepareComposerOverflowResize,
  execute: executeComposerOverflowResize,
  describe(prepared) {
    return `${prepared.originalWidth}px -> narrow -> ${prepared.originalWidth}px`;
  },
  summarize(prepared, result) {
    return summary(
      [
        { name: "hero prompt tip present", passed: prepared.promptTipPresent },
        { name: "viewport narrowed", passed: result.narrowed },
        {
          name: "prompt tip layout measured after resize",
          passed: result.measurementReads > 0
        },
        { name: "viewport restored", passed: result.restored }
      ],
      [
        { label: "Original viewport", value: `${prepared.originalWidth}px` },
        { label: "Narrow viewport", value: `${result.narrowWidth}px` },
        { label: "Prompt tip", value: "hero composer" },
        {
          label: "Layout getter reads",
          value: String(result.measurementReads)
        }
      ],
      "AgentGUI Workbench is fullscreen; native scrollWidth/clientWidth getters are transparently counted while renderer resizes drive the prompt-tip ResizeObserver, then viewport metrics are restored"
    );
  }
};

async function prepareComposerOverflowResize(context, options) {
  const { pageClient } = context;
  const providers = await waitForProviderTiles(pageClient, options.timeoutMs);
  const targetIDValue =
    providers.selectedTargetID ?? providers.tiles[0]?.targetID;
  if (!targetIDValue) {
    throw new Error("composer-overflow-resize has no Agent target");
  }
  if (providers.selectedTargetID !== targetIDValue) {
    await clickProviderTarget(pageClient, targetIDValue);
    await waitForSelectedTarget(pageClient, targetIDValue, options.timeoutMs);
  }
  const windowState = await waitForStableAgentWorkbenchWindow(
    pageClient,
    options.timeoutMs
  );
  if (windowState.displayMode !== "fullscreen") {
    await clickAgentWindowControl(
      pageClient,
      windowState.id,
      "agent-gui-window-toggle-display-mode"
    );
    await waitForAgentWorkbenchWindow(
      pageClient,
      options.timeoutMs,
      "windowState?.displayMode === 'fullscreen'",
      "fullscreen AgentGUI Workbench window",
      windowState.id
    );
  }
  const promptTip = await waitForEvaluation(
    pageClient,
    `(() => {
      const tip = document.querySelector('[data-testid="agent-gui-prompt-tip"]');
      return { ready: Boolean(tip), promptTipPresent: Boolean(tip) };
    })()`,
    options.timeoutMs,
    "hero composer prompt tip"
  );
  const viewport = await waitForStableViewport(pageClient, options.timeoutMs);
  return {
    nodeID: windowState.id,
    originalHeight: viewport.height,
    originalWidth: viewport.width,
    promptTipPresent: promptTip.promptTipPresent
  };
}

async function executeComposerOverflowResize(context, prepared, options) {
  const widths = [760, 680, 600, 520];
  let measurement = null;
  await evaluate(
    context.pageClient,
    `(() => {
      const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
      const clientDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
      if (!scrollDescriptor?.get || !clientDescriptor?.get) {
        throw new Error('native inline layout getters are unavailable');
      }
      const state = window.__tuttiPerfComposerResize = {
        clientWidthReads: 0,
        scrollWidthReads: 0,
        scrollDescriptor,
        clientDescriptor
      };
      Object.defineProperty(Element.prototype, 'scrollWidth', {
        ...scrollDescriptor,
        get() {
          const value = scrollDescriptor.get.call(this);
          if (this instanceof HTMLElement && this.matches('[data-testid="agent-gui-prompt-tip"]')) {
            state.scrollWidthReads += 1;
          }
          return value;
        }
      });
      Object.defineProperty(Element.prototype, 'clientWidth', {
        ...clientDescriptor,
        get() {
          const value = clientDescriptor.get.call(this);
          if (this instanceof HTMLElement && this.matches('[data-testid="agent-gui-prompt-tip"]')) {
            state.clientWidthReads += 1;
          }
          return value;
        }
      });
      return true;
    })()`
  );
  await startRendererScenario(context.pageClient, composerResizeMarkers.start);
  for (const width of widths) {
    await context.pageClient.send("Emulation.setDeviceMetricsOverride", {
      deviceScaleFactor: 1,
      height: prepared.originalHeight,
      mobile: false,
      width
    });
    const viewport = await waitForStableViewport(
      context.pageClient,
      options.timeoutMs
    );
    await markRenderer(context.pageClient, composerResizeMarkers.narrowed);
    measurement = await evaluate(
      context.pageClient,
      `(() => {
        const state = window.__tuttiPerfComposerResize;
        return {
          measurementReads: Math.min(
            state?.scrollWidthReads ?? 0,
            state?.clientWidthReads ?? 0
          ),
          viewportWidth: window.innerWidth
        };
      })()`
    );
    if (measurement?.measurementReads > 0) {
      measurement.viewportWidth = viewport.width;
      break;
    }
  }
  if (!measurement?.measurementReads) {
    throw new Error(
      "prompt tip layout getters were not read after viewport resize"
    );
  }
  await markRenderer(context.pageClient, composerResizeMarkers.overflowing);
  await context.pageClient.send("Emulation.clearDeviceMetricsOverride");
  const restored = await waitForStableViewport(
    context.pageClient,
    options.timeoutMs
  );
  await evaluate(
    context.pageClient,
    `(() => {
      const state = window.__tuttiPerfComposerResize;
      if (!state) return false;
      Object.defineProperty(Element.prototype, 'scrollWidth', state.scrollDescriptor);
      Object.defineProperty(Element.prototype, 'clientWidth', state.clientDescriptor);
      return true;
    })()`
  );
  await markRenderer(context.pageClient, composerResizeMarkers.restored);
  await finishRendererScenario(context.pageClient, composerResizeMarkers.end);
  return {
    narrowWidth: measurement.viewportWidth,
    narrowed: measurement.viewportWidth < prepared.originalWidth,
    measurementReads: measurement.measurementReads,
    restored: Math.abs(restored.width - prepared.originalWidth) <= 2
  };
}

async function enterAndSubmitComposerPrompt(client, prompt, timeoutMs) {
  await evaluate(
    client,
    `(() => {
      const editor = document.querySelector('#agent-gui-detail [contenteditable="true"][role="textbox"]');
      if (!(editor instanceof HTMLElement)) throw new Error('composer editor is unavailable');
      editor.focus();
      document.execCommand('selectAll', false);
      if (!document.execCommand('insertText', false, ${JSON.stringify(prompt)})) {
        throw new Error('could not enter composer prompt');
      }
      return true;
    })()`
  );
  await waitForEvaluation(
    client,
    `(() => {
      const editor = document.querySelector('#agent-gui-detail [contenteditable="true"][role="textbox"]');
      const form = editor?.closest('form');
      const submit = form?.querySelector('button[type="submit"]');
      return { ready: submit instanceof HTMLButtonElement && !submit.disabled };
    })()`,
    timeoutMs,
    "enabled composer submit button",
    25
  );
  await evaluate(
    client,
    `(() => {
      const editor = document.querySelector('#agent-gui-detail [contenteditable="true"][role="textbox"]');
      const form = editor.closest('form');
      if (!(form instanceof HTMLFormElement)) throw new Error('composer form is unavailable');
      form.requestSubmit();
      return true;
    })()`
  );
}
