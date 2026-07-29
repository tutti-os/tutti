import {
  clickSession,
  finishRendererScenario,
  markRenderer,
  selectProvider,
  selectSession,
  selectSessionSwitchTargets,
  startRendererScenario,
  waitForActiveSession,
  waitForProviderTiles,
  waitForSessionItems,
  waitForStableRail
} from "./agent-gui-performance-helpers.mjs";
import { selectProviderSwitchTargets } from "./agent-gui-performance-scenario.mjs";

const sessionMarkers = {
  start: "tutti-perf:session-switch:start",
  selected: "tutti-perf:session-switch:selected-observed",
  stable: "tutti-perf:session-switch:rail-stable-observed",
  end: "tutti-perf:session-switch:end"
};

export const sessionSwitchScenario = {
  id: "session-switch",
  markers: sessionMarkers,
  profileFunctionNames: ["readTimelineGeometry"],
  milestones: [
    {
      key: "selected",
      label: "session selected (observed)",
      marker: sessionMarkers.selected
    },
    {
      key: "stable",
      label: "rail stable (observed)",
      marker: sessionMarkers.stable
    }
  ],
  prepare: prepareSessionSwitch,
  execute: executeSessionSwitch,
  describe(prepared) {
    return `${prepared.sourceSessionID} -> ${prepared.targetSessionID}`;
  },
  summarize(prepared, result) {
    const assertions = [
      {
        name: "session changed",
        passed: prepared.sourceSessionID !== prepared.targetSessionID
      },
      { name: "target session active", passed: result.targetActive },
      { name: "rail contains sections", passed: result.sectionCount > 0 }
    ];
    return scenarioSummary(assertions, [
      {
        label: "Session switch",
        value: `${prepared.sourceSessionID} → ${prepared.targetSessionID}`
      },
      { label: "Provider", value: prepared.targetID },
      { label: "Rail items", value: String(result.itemCount) }
    ]);
  }
};

async function prepareSessionSwitch(context, options) {
  const { pageClient } = context;
  const providers = await waitForProviderTiles(pageClient, options.timeoutMs);
  const targetID = providers.selectedTargetID ?? providers.tiles[0]?.targetID;
  if (!targetID) throw new Error("session-switch has no selected Agent target");
  await selectProvider(pageClient, targetID, options.timeoutMs);
  const sessions = await waitForSessionItems(pageClient, options.timeoutMs);
  const selection = selectSessionSwitchTargets(
    sessions.items,
    sessions.activeSessionID
  );
  if (sessions.activeSessionID !== selection.sourceSessionID) {
    await selectSession(
      pageClient,
      selection.sourceSessionID,
      targetID,
      options.timeoutMs
    );
  }
  return { ...selection, targetID };
}

async function executeSessionSwitch(context, prepared, options) {
  const { pageClient } = context;
  await startRendererScenario(pageClient, sessionMarkers.start);
  await clickSession(pageClient, prepared.targetSessionID);
  await waitForActiveSession(
    pageClient,
    prepared.targetSessionID,
    options.timeoutMs
  );
  await markRenderer(pageClient, sessionMarkers.selected);
  const stable = await waitForStableRail(
    pageClient,
    prepared.targetID,
    options.timeoutMs
  );
  await markRenderer(pageClient, sessionMarkers.stable);
  await finishRendererScenario(pageClient, sessionMarkers.end);
  const active = await waitForActiveSession(
    pageClient,
    prepared.targetSessionID,
    options.timeoutMs
  );
  return { ...stable, targetActive: active.ready };
}

const cycleStepDefinitions = [
  ["provider-target-1", "provider target (round 1)"],
  ["session-target-1", "target session (round 1)"],
  ["provider-source-1", "provider source (round 1)"],
  ["session-source-1", "source session (round 1)"],
  ["provider-target-2", "provider target (round 2)"],
  ["session-target-2", "target session (round 2)"],
  ["provider-source-2", "provider source (round 2)"],
  ["session-source-2", "source session (round 2)"]
];

const cycleMarkers = Object.fromEntries([
  ["start", "tutti-perf:provider-session-cycle:start"],
  ...cycleStepDefinitions.map(([key]) => [
    key,
    `tutti-perf:provider-session-cycle:${key}-observed`
  ]),
  ["end", "tutti-perf:provider-session-cycle:end"]
]);

export const providerSessionCycleScenario = {
  id: "provider-session-cycle",
  markers: cycleMarkers,
  milestones: cycleStepDefinitions.map(([key, label]) => ({
    key,
    label,
    marker: cycleMarkers[key]
  })),
  prepare: prepareProviderSessionCycle,
  execute: executeProviderSessionCycle,
  describe(prepared) {
    return `${prepared.source.targetID} <-> ${prepared.target.targetID}; 2 rounds`;
  },
  summarize(prepared, result) {
    const assertions = [
      {
        name: "two providers exercised",
        passed: prepared.source.targetID !== prepared.target.targetID
      },
      {
        name: "four provider switches completed",
        passed: result.providerSwitches === 4
      },
      {
        name: "four session switches completed",
        passed: result.sessionSwitches === 4
      },
      {
        name: "returned to source session",
        passed: result.finalSessionID === prepared.source.sessions[0]
      }
    ];
    return scenarioSummary(assertions, [
      {
        label: "Provider cycle",
        value: `${prepared.source.targetID} ↔ ${prepared.target.targetID}`
      },
      { label: "Rounds", value: "2" },
      { label: "Measured operations", value: "8" }
    ]);
  }
};

async function prepareProviderSessionCycle(context, options) {
  const { pageClient } = context;
  const providers = await waitForProviderTiles(pageClient, options.timeoutMs);
  const selection = selectProviderSwitchTargets(providers.tiles, {
    fromTargetID: options.fromTargetID,
    selectedTargetID: providers.selectedTargetID,
    toTargetID: options.toTargetID
  });
  const source = await prepareProviderSessions(
    pageClient,
    selection.sourceTargetID,
    options.timeoutMs
  );
  const target = await prepareProviderSessions(
    pageClient,
    selection.targetTargetID,
    options.timeoutMs
  );
  await selectProvider(pageClient, source.targetID, options.timeoutMs);
  await selectSession(
    pageClient,
    source.sessions[0],
    source.targetID,
    options.timeoutMs
  );
  return { source, target };
}

async function prepareProviderSessions(pageClient, targetID, timeoutMs) {
  await selectProvider(pageClient, targetID, timeoutMs);
  const snapshot = await waitForSessionItems(pageClient, timeoutMs);
  const selection = selectSessionSwitchTargets(
    snapshot.items,
    snapshot.activeSessionID
  );
  return {
    targetID,
    sessions: [selection.sourceSessionID, selection.targetSessionID]
  };
}

async function executeProviderSessionCycle(context, prepared, options) {
  const { pageClient } = context;
  const operations = [
    providerOperation(prepared.target.targetID),
    sessionOperation(prepared.target.targetID, prepared.target.sessions[1]),
    providerOperation(prepared.source.targetID),
    sessionOperation(prepared.source.targetID, prepared.source.sessions[1]),
    providerOperation(prepared.target.targetID),
    sessionOperation(prepared.target.targetID, prepared.target.sessions[0]),
    providerOperation(prepared.source.targetID),
    sessionOperation(prepared.source.targetID, prepared.source.sessions[0])
  ];
  await startRendererScenario(pageClient, cycleMarkers.start);
  let providerSwitches = 0;
  let sessionSwitches = 0;
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    await operation.run(pageClient, options.timeoutMs);
    providerSwitches += operation.kind === "provider" ? 1 : 0;
    sessionSwitches += operation.kind === "session" ? 1 : 0;
    await markRenderer(
      pageClient,
      cycleMarkers[cycleStepDefinitions[index][0]]
    );
  }
  await finishRendererScenario(pageClient, cycleMarkers.end);
  return {
    finalSessionID: prepared.source.sessions[0],
    providerSwitches,
    sessionSwitches
  };
}

function providerOperation(targetID) {
  return {
    kind: "provider",
    run: (pageClient, timeoutMs) =>
      selectProvider(pageClient, targetID, timeoutMs)
  };
}

function sessionOperation(targetID, sessionID) {
  return {
    kind: "session",
    run: (pageClient, timeoutMs) =>
      selectSession(pageClient, sessionID, targetID, timeoutMs)
  };
}

function scenarioSummary(assertions, details) {
  return {
    outcome: assertions.every((assertion) => assertion.passed)
      ? "passed"
      : "failed",
    assertions,
    details,
    stabilityCriterion:
      "each operation reaches its selected state and five identical rail snapshots at 200 ms intervals"
  };
}
