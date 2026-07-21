import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  analyzeElectronTrace,
  renderElectronTraceMarkdown
} from "./analyze-electron-trace.mjs";

test("analyzer bounds metrics by scenario markers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutti-trace-analysis-"));
  const tracePath = join(directory, "trace.json");
  try {
    await writeFile(
      tracePath,
      JSON.stringify({
        traceEvents: [
          metadata(1, 2, "CrRendererMain"),
          component(900, "BeforeScenario"),
          marker(1_000, "tutti-perf:provider-switch:start"),
          component(1_100, "HeaderFrame"),
          component(1_200, "Tooltip"),
          component(1_225, "AgentGUIConversationRailSection2"),
          component(1_240, "AgentGUIConversationRailSectionHeader3"),
          component(1_250, "Render"),
          complete(1_300, 20_000, "RunTask"),
          complete(1_400, 5_000, "Layout"),
          input(1_500, "click"),
          input(1_550, "scroll", 4_000),
          completeOnThread(1_600, 80_000, "RunTask", 9, 3),
          timestampMarker(
            2_000,
            "tutti-perf:provider-switch:selected-observed"
          ),
          marker(4_000, "tutti-perf:provider-switch:rail-stable-observed"),
          marker(30_000, "tutti-perf:provider-switch:end"),
          component(31_000, "AfterScenario"),
          profileChunk(1_600, {
            nodes: [
              profileNode(1, "(root)"),
              profileNode(2, "hasSelection", 1),
              profileNode(3, "updateStateInner", 2)
            ],
            samples: [2, 3]
          })
        ]
      })
    );

    const summary = await analyzeElectronTrace({
      tracePath,
      scenario: "provider-switch",
      startMarker: "tutti-perf:provider-switch:start",
      endMarker: "tutti-perf:provider-switch:end",
      milestones: [
        {
          key: "selected",
          label: "target selected",
          marker: "tutti-perf:provider-switch:selected-observed"
        },
        {
          key: "stable",
          label: "rail stable",
          marker: "tutti-perf:provider-switch:rail-stable-observed"
        }
      ],
      minimumLongEventMs: 16,
      profileFunctionNames: ["hasSelection", "updateStateInner"]
    });

    assert.equal(summary.window.durationMs, 29);
    assert.equal(summary.renders.componentMarkers, 4);
    assert.equal(summary.renders.radixFamilyMarkers, 1);
    assert.equal(summary.renders.headerFrameMarkers, 1);
    assert.equal(summary.renders.sectionMarkers, 1);
    assert.equal(summary.renders.sectionHeaderMarkers, 1);
    assert.equal(summary.timing.longTaskCount, 1);
    assert.equal(summary.timing.maxLongTaskMs, 20);
    assert.equal(summary.timing.layoutInclusiveMs, 5);
    assert.deepEqual(
      summary.window.phases.map((phase) => phase.durationMs),
      [1, 2, 26]
    );
    assert.deepEqual(summary.inputEvents, { click: 1, scroll: 1 });
    assert.deepEqual(summary.inputEventTiming.scroll, {
      count: 1,
      totalInclusiveMs: 4,
      maxMs: 4
    });
    assert.deepEqual(summary.cpuProfile.functionSamples, {
      hasSelection: 2,
      updateStateInner: 1
    });
    assert.equal(summary.cpuProfile.sampleCount, 2);
    assert.match(renderElectronTraceMarkdown(summary), /report-only/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analyzer rejects traces without the scenario end marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutti-trace-analysis-"));
  const tracePath = join(directory, "trace.json");
  try {
    await writeFile(
      tracePath,
      JSON.stringify({
        traceEvents: [marker(1_000, "start"), component(1_100, "Tooltip")]
      })
    );
    await assert.rejects(
      analyzeElectronTrace({
        tracePath,
        scenario: "missing-end",
        startMarker: "start",
        endMarker: "end"
      }),
      /trace marker not found: end/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analyzer rejects traces with a missing declared milestone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutti-trace-analysis-"));
  const tracePath = join(directory, "trace.json");
  try {
    await writeFile(
      tracePath,
      JSON.stringify({
        traceEvents: [marker(1_000, "start"), marker(2_000, "end")]
      })
    );
    await assert.rejects(
      analyzeElectronTrace({
        tracePath,
        scenario: "missing-milestone",
        startMarker: "start",
        endMarker: "end",
        milestones: [{ key: "middle", label: "middle", marker: "middle" }]
      }),
      /trace milestones not found: middle/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function marker(ts, name) {
  return { name, ph: "R", pid: 1, tid: 2, ts };
}

function timestampMarker(ts, message) {
  return {
    args: { data: { message } },
    name: "TimeStamp",
    ph: "I",
    pid: 1,
    tid: 2,
    ts
  };
}

function metadata(pid, tid, name) {
  return { args: { name }, name: "thread_name", ph: "M", pid, tid, ts: 1 };
}

function component(ts, message) {
  return {
    args: { data: { message } },
    cat: "devtools.timeline",
    name: "TimeStamp",
    ph: "I",
    pid: 1,
    tid: 2,
    ts
  };
}

function complete(ts, dur, name) {
  return { dur, name, ph: "X", pid: 1, tid: 2, ts };
}

function completeOnThread(ts, dur, name, pid, tid) {
  return { dur, name, ph: "X", pid, tid, ts };
}

function input(ts, type, dur = 10) {
  return {
    args: { data: { type } },
    dur,
    name: "EventDispatch",
    ph: "X",
    pid: 1,
    tid: 2,
    ts
  };
}

function profileChunk(ts, cpuProfile) {
  return {
    args: {
      data: { cpuProfile, timeDeltas: cpuProfile.samples.map(() => 100) }
    },
    id: "0x1",
    name: "ProfileChunk",
    ph: "P",
    pid: 1,
    tid: 4,
    ts
  };
}

function profileNode(id, functionName, parent) {
  return {
    callFrame: { functionName, scriptId: 1 },
    id,
    ...(parent == null ? {} : { parent })
  };
}
