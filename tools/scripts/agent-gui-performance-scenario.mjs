import {
  clickProviderTarget,
  finishRendererScenario,
  markRenderer,
  normalizeOptionalString,
  selectProvider,
  startRendererScenario,
  waitForProviderTiles,
  waitForSelectedTarget,
  waitForStableRail
} from "./agent-gui-performance-helpers.mjs";

const markers = {
  start: "tutti-perf:provider-switch:start",
  selected: "tutti-perf:provider-switch:selected-observed",
  stable: "tutti-perf:provider-switch:rail-stable-observed",
  end: "tutti-perf:provider-switch:end"
};

export const providerSwitchScenario = {
  id: "provider-switch",
  markers,
  milestones: [
    {
      key: "selected",
      label: "target selected (observed)",
      marker: markers.selected
    },
    {
      key: "stable",
      label: "rail stable (observed)",
      marker: markers.stable
    }
  ],
  prepare: prepareProviderSwitchScenario,
  execute: executeProviderSwitchScenario,
  describe(prepared) {
    return `${prepared.sourceTargetID} -> ${prepared.targetTargetID}; ${prepared.sectionCount} sections`;
  },
  summarize(prepared, result) {
    const assertions = [
      {
        name: "target changed",
        passed: prepared.sourceTargetID !== prepared.targetTargetID
      },
      { name: "target selected", passed: result.selected === true },
      { name: "rail contains sections", passed: result.sectionCount > 0 }
    ];
    return {
      outcome: assertions.every((assertion) => assertion.passed)
        ? "passed"
        : "failed",
      assertions,
      details: [
        {
          label: "Provider switch",
          value: `${prepared.sourceTargetID} → ${prepared.targetTargetID}`
        },
        {
          label: "Sections",
          value: `${prepared.sectionCount} → ${result.sectionCount}`
        },
        {
          label: "Items",
          value: `${prepared.itemCount} → ${result.itemCount}`
        }
      ],
      stabilityCriterion:
        "five identical rail snapshots at 200 ms intervals, then two animation frames plus 250 ms settling tail"
    };
  }
};

export async function prepareProviderSwitchScenario(context, options) {
  const { pageClient } = context;
  const initial = await waitForProviderTiles(pageClient, options.timeoutMs);
  const targetSelection = selectProviderSwitchTargets(initial.tiles, {
    fromTargetID: options.fromTargetID,
    selectedTargetID: initial.selectedTargetID,
    toTargetID: options.toTargetID
  });
  if (initial.selectedTargetID !== targetSelection.sourceTargetID) {
    await selectProvider(
      pageClient,
      targetSelection.sourceTargetID,
      options.timeoutMs
    );
  }
  const stable = await waitForStableRail(
    pageClient,
    targetSelection.sourceTargetID,
    options.timeoutMs
  );
  return {
    ...targetSelection,
    sectionCount: stable.sectionCount,
    itemCount: stable.itemCount
  };
}

export function selectProviderSwitchTargets(tiles, options = {}) {
  const available = tiles.filter(
    (tile) => tile.targetID && tile.disabled !== true
  );
  if (available.length < 2) {
    throw new Error(
      "provider-switch requires at least two enabled Agent targets"
    );
  }
  const sourceTargetID =
    normalizeOptionalString(options.fromTargetID) ??
    (available.some((tile) => tile.targetID === options.selectedTargetID)
      ? options.selectedTargetID
      : available[0].targetID);
  const targetTargetID =
    normalizeOptionalString(options.toTargetID) ??
    available.find((tile) => tile.targetID !== sourceTargetID)?.targetID;
  if (!available.some((tile) => tile.targetID === sourceTargetID)) {
    throw new Error(`source Agent target is not visible: ${sourceTargetID}`);
  }
  if (
    !targetTargetID ||
    targetTargetID === sourceTargetID ||
    !available.some((tile) => tile.targetID === targetTargetID)
  ) {
    throw new Error(`target Agent target is not visible: ${targetTargetID}`);
  }
  return { sourceTargetID, targetTargetID };
}

export async function executeProviderSwitchScenario(
  context,
  prepared,
  options
) {
  const { pageClient } = context;
  await startRendererScenario(pageClient, markers.start);
  await clickProviderTarget(pageClient, prepared.targetTargetID);
  await waitForSelectedTarget(
    pageClient,
    prepared.targetTargetID,
    options.timeoutMs
  );
  await markRenderer(pageClient, markers.selected);
  const stable = await waitForStableRail(
    pageClient,
    prepared.targetTargetID,
    options.timeoutMs
  );
  await markRenderer(pageClient, markers.stable);
  await finishRendererScenario(pageClient, markers.end);
  return stable;
}
