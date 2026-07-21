#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveComponentSources } from "./resolve-component-sources.mjs";

const defaultMinimumLongEventMs = 16;
const reactTrackMessages = new Set([
  "Blocking Track",
  "Commit",
  "Idle Track",
  "Layout Effects",
  "Passive Effects",
  "Remaining Effects",
  "Render",
  "Suspense Track",
  "Transition Track"
]);
const radixComponentPattern =
  /(Collection|ContextMenu|DropdownMenu|MenuContent|MenuItem|MenuPortal|MenuRoot|Popper|Portal|Presence|Primitive|Slot|Tooltip)/u;

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  const summary = await analyzeElectronTrace({
    tracePath: options.tracePath,
    scenario: options.scenario,
    startMarker: options.startMarker,
    endMarker: options.endMarker,
    minimumLongEventMs: options.minimumLongEventMs,
    sourceRoot: options.sourceRoot ?? process.cwd()
  });
  if (options.format === "markdown") {
    process.stdout.write(
      renderElectronTraceMarkdown(summary, {
        sourceRoot: options.sourceRoot ?? process.cwd()
      })
    );
    return;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export async function analyzeElectronTrace(input) {
  const tracePath = resolve(input.tracePath);
  const startMarker = input.startMarker.trim();
  const endMarker = input.endMarker.trim();
  const minimumLongEventMs =
    input.minimumLongEventMs ?? defaultMinimumLongEventMs;
  const minimumLongEventUs = minimumLongEventMs * 1_000;
  const milestoneByMarker = new Map(
    (input.milestones ?? []).map((milestone) => [milestone.marker, milestone])
  );
  const milestoneTimestamps = new Map();
  const threadNames = new Map();
  const componentThreadCounts = new Map();
  const threadAnalyses = new Map();
  const cpuProfiles = new Map();
  const profileFunctionNames = new Set(input.profileFunctionNames ?? []);
  const profileFunctionSamples = Object.fromEntries(
    [...profileFunctionNames].map((functionName) => [functionName, 0])
  );
  const processIDs = new Set();
  let traceEventCount = 0;
  let scenarioEventCount = 0;
  let scenarioStartUs = null;
  let scenarioEndUs = null;
  let scenarioRendererProcessID = null;
  let profileSampleCount = 0;

  await streamTraceEvents(tracePath, (event) => {
    traceEventCount += 1;
    const thread = `${event.pid ?? "?"}:${event.tid ?? "?"}`;
    if (event.pid != null) processIDs.add(event.pid);
    if (
      event.ph === "M" &&
      event.name === "thread_name" &&
      typeof event.args?.name === "string"
    ) {
      threadNames.set(thread, event.args.name);
    }

    const timestampUs = finiteNumber(event.ts);
    const markerName = traceMarkerName(event);
    if (markerName === startMarker && timestampUs !== null) {
      scenarioStartUs = timestampUs;
      scenarioRendererProcessID = event.pid ?? null;
      return true;
    }
    const milestone = milestoneByMarker.get(markerName);
    if (
      scenarioStartUs !== null &&
      milestone &&
      timestampUs !== null &&
      !milestoneTimestamps.has(milestone.key)
    ) {
      milestoneTimestamps.set(milestone.key, timestampUs);
    }
    if (
      scenarioStartUs !== null &&
      markerName === endMarker &&
      timestampUs !== null
    ) {
      scenarioEndUs = timestampUs;
      return true;
    }
    profileSampleCount += processProfileChunk({
      countSamples:
        scenarioStartUs !== null &&
        timestampUs !== null &&
        timestampUs >= scenarioStartUs &&
        (scenarioEndUs === null || timestampUs <= scenarioEndUs) &&
        event.pid === scenarioRendererProcessID,
      event,
      functionNames: profileFunctionNames,
      functionSamples: profileFunctionSamples,
      profiles: cpuProfiles
    });
    if (scenarioStartUs === null || timestampUs === null) {
      return true;
    }
    if (scenarioEndUs !== null && timestampUs >= scenarioEndUs) {
      return true;
    }

    scenarioEventCount += 1;
    const threadAnalysis = getThreadAnalysis(threadAnalyses, thread);
    threadAnalysis.eventCount += 1;
    const componentName = traceComponentName(event);
    if (componentName) {
      threadAnalysis.componentMarkerCount += 1;
      incrementCount(threadAnalysis.componentCounts, componentName);
      incrementCount(componentThreadCounts, thread);
      if (radixComponentPattern.test(componentName)) {
        threadAnalysis.radixComponentMarkerCount += 1;
      }
    }

    if (event.name === "EventDispatch") {
      const eventType = event.args?.data?.type;
      if (typeof eventType === "string") {
        incrementCount(threadAnalysis.inputEventCounts, eventType);
        const inputDurationUs = finiteNumber(event.dur) ?? 0;
        if (event.ph === "X" && inputDurationUs > 0) {
          updateDurationStats(
            threadAnalysis.inputEventStats,
            eventType,
            inputDurationUs
          );
        }
      }
    }

    const durationUs = finiteNumber(event.dur) ?? 0;
    if (event.ph !== "X" || durationUs <= 0) {
      return true;
    }
    const name = typeof event.name === "string" ? event.name : "<unnamed>";
    updateDurationStats(threadAnalysis.eventStats, name, durationUs);
    if (name === "RunTask" && durationUs >= minimumLongEventUs) {
      threadAnalysis.longTaskCount += 1;
      updateLongestTasks(threadAnalysis.longestTasks, {
        durationMs: round(durationUs / 1_000),
        timestampOffsetMs: round((timestampUs - scenarioStartUs) / 1_000)
      });
    }
    return true;
  });

  if (scenarioStartUs === null) {
    throw new Error(`trace marker not found: ${startMarker}`);
  }
  if (scenarioEndUs === null) {
    throw new Error(`trace marker not found: ${endMarker}`);
  }
  const missingMilestones = (input.milestones ?? []).filter(
    (milestone) => !milestoneTimestamps.has(milestone.key)
  );
  if (missingMilestones.length > 0) {
    throw new Error(
      `trace milestones not found: ${missingMilestones.map((milestone) => milestone.marker).join(", ")}`
    );
  }

  const file = await stat(tracePath);
  const rendererThread = selectRendererThread(
    componentThreadCounts,
    threadNames,
    threadAnalyses
  );
  const renderer = rendererThread
    ? (threadAnalyses.get(rendererThread) ?? createThreadAnalysis())
    : createThreadAnalysis();
  const unresolvedTopComponents = topCountEntries(
    renderer.componentCounts,
    30
  ).map(([name, count]) => ({ name, count }));
  const topComponents = input.sourceRoot
    ? await resolveComponentSources(unresolvedTopComponents, input.sourceRoot)
    : unresolvedTopComponents;
  const topEvents = topDurationEntries(renderer.eventStats, 20).map(
    ([name, value]) => ({
      name,
      count: value.count,
      totalInclusiveMs: round(value.totalUs / 1_000),
      maxMs: round(value.maxUs / 1_000)
    })
  );
  const phases = buildPhases({
    startUs: scenarioStartUs,
    endUs: scenarioEndUs,
    milestones: input.milestones ?? [],
    milestoneTimestamps
  });

  return {
    schemaVersion: 2,
    mode: "report-only",
    scenario: input.scenario,
    verdict: {
      status: "ungraded",
      reason: "no comparable baseline or threshold configured"
    },
    trace: {
      file: basename(tracePath),
      bytes: file.size,
      parsedEventCount: traceEventCount,
      processCount: processIDs.size
    },
    window: {
      startMarker,
      endMarker,
      durationMs: round((scenarioEndUs - scenarioStartUs) / 1_000),
      eventCount: scenarioEventCount,
      rendererEventCount: renderer.eventCount,
      phases
    },
    rendererThread: rendererThread
      ? {
          key: rendererThread,
          name: threadNames.get(rendererThread) ?? null,
          selectionReason:
            (componentThreadCounts.get(rendererThread) ?? 0) > 0
              ? "most React component markers"
              : "CrRendererMain fallback"
        }
      : null,
    renders: {
      componentMarkers: renderer.componentMarkerCount,
      radixFamilyMarkers: renderer.radixComponentMarkerCount,
      headerFrameMarkers: countComponentFamily(
        renderer.componentCounts,
        "HeaderFrame"
      ),
      sectionMarkers: countComponentFamily(
        renderer.componentCounts,
        "AgentGUIConversationRailSection"
      ),
      sectionHeaderMarkers: countComponentFamily(
        renderer.componentCounts,
        "AgentGUIConversationRailSectionHeader"
      ),
      topComponents
    },
    timing: {
      longTaskThresholdMs: minimumLongEventMs,
      longTaskCount: renderer.longTaskCount,
      maxLongTaskMs: renderer.longestTasks[0]?.durationMs ?? 0,
      functionCallInclusiveMs: inclusiveDurationForNames(renderer.eventStats, [
        "FunctionCall"
      ]),
      updateLayoutTreeInclusiveMs: inclusiveDurationForNames(
        renderer.eventStats,
        ["UpdateLayoutTree"]
      ),
      layoutInclusiveMs: inclusiveDurationForNames(renderer.eventStats, [
        "Layout"
      ]),
      prePaintInclusiveMs: inclusiveDurationForNames(renderer.eventStats, [
        "PrePaint"
      ]),
      paintInclusiveMs: inclusiveDurationForNames(renderer.eventStats, [
        "Paint"
      ]),
      topEvents,
      longestTasks: renderer.longestTasks
    },
    inputEvents: Object.fromEntries(
      [...renderer.inputEventCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
    inputEventTiming: durationStatsSummary(renderer.inputEventStats),
    cpuProfile: {
      sampleCount: profileSampleCount,
      functionSamples: profileFunctionSamples
    },
    cautions: [
      "Timing and event totals are restricted to the selected renderer main thread.",
      "Inclusive duration totals may overlap; do not sum them into wall time.",
      "React component counts come from development component tracks and include profiling overhead.",
      "Component source links are static declaration matches, not runtime stack attribution.",
      "Source links resolve against the current checkout and may drift from the revision that produced an imported trace.",
      "CPU profile function counts are inclusive sampled stacks whose ProfileChunk event falls inside the marker window.",
      "The standalone analyzer is report-only; a capture scenario may apply explicit thresholds to these metrics."
    ]
  };
}

export function renderElectronTraceMarkdown(summary, options = {}) {
  const lines = [
    `# Desktop performance: ${summary.scenario}`,
    "",
    "## Summary",
    "",
    `- Performance verdict: ${summary.verdict.status} — ${summary.verdict.reason}`,
    `- Mode: ${summary.mode}; ${summary.mode === "report-only" ? "metric values never fail the command" : "configured scenario thresholds fail the command"}`,
    `- Scenario window: ${summary.window.durationMs} ms`,
    `- Renderer thread: ${summary.rendererThread?.name ?? "unresolved"} (${summary.rendererThread?.key ?? "n/a"}; ${summary.rendererThread?.selectionReason ?? "n/a"})`,
    `- Renderer events: ${summary.window.rendererEventCount.toLocaleString("en-US")} of ${summary.window.eventCount.toLocaleString("en-US")} trace-window events`,
    "",
    "## Phase timings",
    "",
    "Observed marker phases; polling-based milestones are not exact browser input latency.",
    "",
    "| Phase | Duration ms |",
    "| --- | ---: |",
    ...(summary.window.phases.length > 0
      ? summary.window.phases.map(
          (phase) =>
            `| ${escapeMarkdown(phase.fromLabel)} → ${escapeMarkdown(phase.toLabel)} | ${phase.durationMs} |`
        )
      : ["| start → end | " + summary.window.durationMs + " |"]),
    "",
    "## Renderer main thread",
    "",
    `- RunTask >= ${summary.timing.longTaskThresholdMs} ms: ${summary.timing.longTaskCount.toLocaleString("en-US")}`,
    `- Max RunTask: ${summary.timing.maxLongTaskMs} ms`,
    `- FunctionCall inclusive: ${summary.timing.functionCallInclusiveMs} ms`,
    `- UpdateLayoutTree inclusive: ${summary.timing.updateLayoutTreeInclusiveMs} ms`,
    `- Layout inclusive: ${summary.timing.layoutInclusiveMs} ms`,
    `- PrePaint inclusive: ${summary.timing.prePaintInclusiveMs} ms`,
    `- Paint inclusive: ${summary.timing.paintInclusiveMs} ms`,
    "",
    "## Input event timing",
    "",
    "| Event | Count | Total ms | Max ms |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(summary.inputEventTiming).map(
      ([eventType, timing]) =>
        `| ${escapeMarkdown(eventType)} | ${timing.count} | ${timing.totalInclusiveMs} | ${timing.maxMs} |`
    ),
    "",
    "## Sampled JavaScript functions",
    "",
    "| Function | Inclusive samples |",
    "| --- | ---: |",
    ...Object.entries(summary.cpuProfile.functionSamples).map(
      ([functionName, samples]) =>
        `| ${escapeMarkdown(functionName)} | ${samples} |`
    ),
    "",
    "## React component fanout",
    "",
    `- Component markers: ${summary.renders.componentMarkers.toLocaleString("en-US")}`,
    `- Radix-family markers: ${summary.renders.radixFamilyMarkers.toLocaleString("en-US")}`,
    `- HeaderFrame markers: ${summary.renders.headerFrameMarkers.toLocaleString("en-US")}`,
    `- Section markers: ${summary.renders.sectionMarkers.toLocaleString("en-US")}`,
    `- Section header markers: ${summary.renders.sectionHeaderMarkers.toLocaleString("en-US")}`,
    "",
    "| Component | Markers | Static declaration |",
    "| --- | ---: | --- |",
    ...summary.renders.topComponents.map(
      (entry) =>
        `| ${escapeMarkdown(entry.name)} | ${entry.count} | ${formatComponentSource(entry, options.sourceRoot)} |`
    ),
    "",
    "## Top renderer inclusive events",
    "",
    "| Event | Count | Total ms | Max ms |",
    "| --- | ---: | ---: | ---: |",
    ...summary.timing.topEvents.map(
      (entry) =>
        `| ${escapeMarkdown(entry.name)} | ${entry.count} | ${entry.totalInclusiveMs} | ${entry.maxMs} |`
    ),
    "",
    "## Longest renderer RunTask events",
    "",
    "| Offset ms | Duration ms |",
    "| ---: | ---: |",
    ...(summary.timing.longestTasks.length > 0
      ? summary.timing.longestTasks.map(
          (entry) => `| ${entry.timestampOffsetMs} | ${entry.durationMs} |`
        )
      : ["| — | — |"]),
    "",
    "## Notes",
    "",
    ...summary.cautions.map((caution) => `- ${caution}`),
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function traceComponentName(event) {
  if (event.name !== "TimeStamp") {
    return null;
  }
  const message = event.args?.data?.message;
  if (
    typeof message !== "string" ||
    !message.trim() ||
    reactTrackMessages.has(message) ||
    message.startsWith("tutti-perf:")
  ) {
    return null;
  }
  return message.trim();
}

function traceMarkerName(event) {
  if (event.name !== "TimeStamp") return event.name;
  const message = event.args?.data?.message;
  return typeof message === "string" && message.startsWith("tutti-perf:")
    ? message
    : event.name;
}

async function streamTraceEvents(path, onEvent) {
  const marker = '"traceEvents"';
  let state = "search-marker";
  let searchTail = "";
  let objectText = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    consume(chunk);
    if (state === "done") {
      break;
    }
  }
  if (state === "search-marker" || state === "wait-array") {
    throw new Error('trace JSON does not contain a "traceEvents" array');
  }
  if (objectText) {
    throw new Error("trace ended inside a trace event");
  }

  function consume(chunk) {
    let text = chunk;
    if (state === "search-marker") {
      const candidate = searchTail + text;
      const markerIndex = candidate.indexOf(marker);
      if (markerIndex < 0) {
        searchTail = candidate.slice(-marker.length);
        return;
      }
      text = candidate.slice(markerIndex + marker.length);
      searchTail = "";
      state = "wait-array";
    }
    if (state === "wait-array") {
      const arrayIndex = text.indexOf("[");
      if (arrayIndex < 0) {
        return;
      }
      text = text.slice(arrayIndex + 1);
      state = "read-array";
    }
    if (state !== "read-array") {
      return;
    }

    for (const character of text) {
      if (!objectText) {
        if (character === "{") {
          objectText = character;
          depth = 1;
          inString = false;
          escaped = false;
        } else if (character === "]") {
          state = "done";
          return;
        }
        continue;
      }

      objectText += character;
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          const shouldContinue = onEvent(JSON.parse(objectText));
          objectText = "";
          if (shouldContinue === false) {
            state = "done";
            return;
          }
        }
      }
    }
  }
}

function getThreadAnalysis(analyses, thread) {
  let analysis = analyses.get(thread);
  if (!analysis) {
    analysis = createThreadAnalysis();
    analyses.set(thread, analysis);
  }
  return analysis;
}

function createThreadAnalysis() {
  return {
    eventCount: 0,
    eventStats: new Map(),
    inputEventCounts: new Map(),
    inputEventStats: new Map(),
    componentCounts: new Map(),
    componentMarkerCount: 0,
    radixComponentMarkerCount: 0,
    longTaskCount: 0,
    longestTasks: []
  };
}

function processProfileChunk(input) {
  const data = input.event.args?.data;
  if (
    input.event.name !== "ProfileChunk" ||
    !data?.cpuProfile ||
    input.event.pid == null ||
    input.functionNames.size === 0
  ) {
    return 0;
  }
  const profileKey = `${input.event.pid}:${input.event.id ?? "default"}`;
  let nodes = input.profiles.get(profileKey);
  if (!nodes) {
    nodes = new Map();
    input.profiles.set(profileKey, nodes);
  }
  for (const node of data.cpuProfile.nodes ?? []) {
    if (node?.id != null) nodes.set(node.id, node);
  }
  if (!input.countSamples) return 0;
  const samples = data.cpuProfile.samples ?? [];
  for (const sampleID of samples) {
    const matchedFunctions = new Set();
    const visitedNodes = new Set();
    let node = nodes.get(sampleID);
    while (node && !visitedNodes.has(node.id)) {
      visitedNodes.add(node.id);
      const functionName = node.callFrame?.functionName;
      if (input.functionNames.has(functionName)) {
        matchedFunctions.add(functionName);
      }
      node = nodes.get(node.parent);
    }
    for (const functionName of matchedFunctions) {
      input.functionSamples[functionName] += 1;
    }
  }
  return samples.length;
}

function durationStatsSummary(stats) {
  return Object.fromEntries(
    [...stats.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        {
          count: value.count,
          totalInclusiveMs: round(value.totalUs / 1_000),
          maxMs: round(value.maxUs / 1_000)
        }
      ])
  );
}

function selectRendererThread(componentCounts, threadNames, analyses) {
  const componentThread = maxCountEntry(componentCounts)?.[0];
  if (componentThread) return componentThread;
  return [...threadNames.entries()]
    .filter(([, name]) => name === "CrRendererMain")
    .sort(
      ([leftKey], [rightKey]) =>
        (analyses.get(rightKey)?.eventCount ?? 0) -
          (analyses.get(leftKey)?.eventCount ?? 0) ||
        leftKey.localeCompare(rightKey)
    )[0]?.[0];
}

function updateLongestTasks(tasks, task) {
  tasks.push(task);
  tasks.sort((left, right) => right.durationMs - left.durationMs);
  if (tasks.length > 20) tasks.length = 20;
}

function buildPhases(input) {
  const points = [
    { key: "start", label: "scenario start", timestampUs: input.startUs },
    ...input.milestones
      .map((milestone) => ({
        key: milestone.key,
        label: milestone.label,
        timestampUs: input.milestoneTimestamps.get(milestone.key) ?? null
      }))
      .filter((point) => point.timestampUs !== null),
    { key: "end", label: "scenario end", timestampUs: input.endUs }
  ].sort((left, right) => left.timestampUs - right.timestampUs);
  return points.slice(1).map((point, index) => ({
    from: points[index].key,
    fromLabel: points[index].label,
    to: point.key,
    toLabel: point.label,
    durationMs: round((point.timestampUs - points[index].timestampUs) / 1_000)
  }));
}

function updateDurationStats(target, key, durationUs) {
  const value = target.get(key) ?? { count: 0, totalUs: 0, maxUs: 0 };
  value.count += 1;
  value.totalUs += durationUs;
  value.maxUs = Math.max(value.maxUs, durationUs);
  target.set(key, value);
}

function incrementCount(target, key) {
  target.set(key, (target.get(key) ?? 0) + 1);
}

function topCountEntries(values, limit) {
  return [...values.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
    )
    .slice(0, limit);
}

function topDurationEntries(values, limit) {
  return [...values.entries()]
    .sort(
      (left, right) =>
        right[1].totalUs - left[1].totalUs || left[0].localeCompare(right[0])
    )
    .slice(0, limit);
}

function maxCountEntry(values) {
  return topCountEntries(values, 1)[0] ?? null;
}

function countComponentFamily(values, baseName) {
  let count = 0;
  for (const [name, value] of values) {
    const suffix = name.slice(baseName.length);
    if (
      name === baseName ||
      (name.startsWith(baseName) && /^\d+$/u.test(suffix))
    ) {
      count += value;
    }
  }
  return count;
}

function inclusiveDurationForNames(values, names) {
  const totalUs = names.reduce(
    (total, name) => total + (values.get(name)?.totalUs ?? 0),
    0
  );
  return round(totalUs / 1_000);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function escapeMarkdown(value) {
  return String(value).replaceAll("|", "\\|");
}

function formatComponentSource(entry, sourceRoot) {
  if (!entry.source) {
    return entry.sourceResolution?.status === "ambiguous"
      ? `ambiguous (${entry.sourceResolution.candidateCount} declarations)`
      : "unresolved / external";
  }
  const label = `${entry.source.file}:${entry.source.line}`;
  if (!sourceRoot) return escapeMarkdown(label);
  const target = `${resolve(sourceRoot, entry.source.file)}:${entry.source.line}`;
  const markdownTarget = target.includes(" ") ? `<${target}>` : target;
  return `[${escapeMarkdown(label)}](${markdownTarget})`;
}

function parseArgs(argv) {
  const options = {
    format: "json",
    minimumLongEventMs: defaultMinimumLongEventMs,
    scenario: "desktop-interaction"
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--scenario") {
      options.scenario = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--start-marker") {
      options.startMarker = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--end-marker") {
      options.endMarker = requiredValue(argv, (index += 1), arg);
    } else if (arg === "--source-root") {
      options.sourceRoot = resolve(requiredValue(argv, (index += 1), arg));
    } else if (arg === "--min-ms") {
      options.minimumLongEventMs = positiveNumber(
        requiredValue(argv, (index += 1), arg),
        arg
      );
    } else if (arg === "--format") {
      options.format = requiredValue(argv, (index += 1), arg);
      if (!new Set(["json", "markdown"]).has(options.format)) {
        throw new Error("--format must be json or markdown");
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (options.help) return options;
  if (positional.length !== 1) {
    throw new Error("provide exactly one trace JSON path");
  }
  if (!options.startMarker || !options.endMarker) {
    throw new Error("--start-marker and --end-marker are required");
  }
  options.tracePath = positional[0];
  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positiveNumber(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return number;
}

function isMainModule() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

function printUsage() {
  const usage = `Analyze one marker-bounded Electron trace window.\n\nUsage:\n  node tools/scripts/analyze-electron-trace.mjs TRACE.json \\\n+    --scenario provider-switch \\\n+    --start-marker tutti-perf:provider-switch:start \\\n+    --end-marker tutti-perf:provider-switch:end\n\nOptions:\n  --format <json|markdown>  Output format. Default: json\n  --min-ms <milliseconds>   Long event threshold. Default: 16\n  --scenario <name>         Scenario label\n  --start-marker <name>     performance.mark name at scenario start\n  --end-marker <name>       performance.mark name at scenario end\n`;
  process.stdout.write(
    usage
      .replaceAll("\n+", "\n")
      .replace("Long event threshold", "Renderer RunTask threshold")
      .replace(
        "  --scenario <name>         Scenario label",
        "  --scenario <name>         Scenario label\n  --source-root <path>      Resolve local component declarations"
      )
  );
}
