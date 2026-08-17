import assert from "node:assert/strict";
import test from "node:test";
import {
  providerSwitchScenario,
  selectProviderSwitchTargets
} from "./agent-gui-performance-scenario.mjs";
import { selectSessionSwitchTargets } from "./agent-gui-performance-helpers.mjs";
import {
  agentGuiPerformanceScenarios,
  resolveAgentGuiPerformanceScenario
} from "./agent-gui-performance-scenarios.mjs";
import { sessionSwitchScenario } from "./agent-gui-session-performance-scenarios.mjs";
import { composerInputScenario } from "./agent-gui-composer-performance-scenarios.mjs";
import {
  assessWorkbenchWindowDragTrace,
  prepareAgentGUIWindowStressSnapshot
} from "./agent-gui-window-performance-scenarios.mjs";
import { summarizeProviderStatusFocusRefresh } from "./agent-provider-status-performance-scenario.mjs";
import { buildAllProcessTimeProfileArgs } from "./all-process-time-profile.mjs";
import { prepareConcurrentAgentStreamingWorkbenchSnapshot } from "./agent-gui-concurrent-streaming-performance-scenario.mjs";
import {
  assessWorkbenchDockPopupPreviewTrace,
  prepareWorkbenchDockPopupPreviewSnapshot
} from "./agent-gui-dock-preview-performance-scenario.mjs";
import { isDesktopBundleFresh } from "./prepared-desktop-launch.mjs";
import {
  applyScenarioAssessment,
  findUnknownAgentTargetMigrationIDs,
  parseDesktopStartupFailure,
  performanceRunFailureReasons,
  prepareWorkbenchSnapshotForPerformance
} from "./run-agent-gui-performance.mjs";

test("parses the structured Desktop startup failure from process output", () => {
  assert.deepEqual(
    parseDesktopStartupFailure(
      [
        "ordinary output",
        '[tutti-desktop-startup-failed] {"message":"tuttid exited","cause":{"code":"managed_process_stderr","message":"unsupported process cassette schema version 2"}}',
        "[desktop] bootstrap failed"
      ].join("\n")
    ),
    {
      cause: {
        code: "managed_process_stderr",
        message: "unsupported process cassette schema version 2"
      },
      message: "tuttid exited"
    }
  );
});

test("reuses a prepared Desktop bundle until source output is newer", () => {
  assert.equal(
    isDesktopBundleFresh({ outputMtimeMs: 20, sourceMtimeMs: 20 }),
    true
  );
  assert.equal(
    isDesktopBundleFresh({ outputMtimeMs: 19, sourceMtimeMs: 20 }),
    false
  );
  assert.equal(
    isDesktopBundleFresh({ outputMtimeMs: Number.NaN, sourceMtimeMs: 20 }),
    false
  );
});

test("scenario trace assessment turns report metrics into a gate", () => {
  const summary = {
    mode: "report-only",
    verdict: { status: "ungraded", reason: "report only" },
    run: {
      assertions: [{ name: "semantic contract", passed: true }],
      details: [],
      outcome: "passed"
    }
  };

  applyScenarioAssessment(summary, {
    assertions: [
      { name: "scroll budget", passed: true },
      { name: "EditorView samples", passed: false }
    ],
    details: [{ label: "Scroll", value: "4 ms" }]
  });

  assert.equal(summary.mode, "scenario-thresholds");
  assert.deepEqual(summary.verdict, {
    status: "failed",
    reason: "1 of 3 scenario assertions failed"
  });
  assert.equal(summary.run.outcome, "failed");
  assert.deepEqual(summary.run.details, [{ label: "Scroll", value: "4 ms" }]);
});

test("failed scenario contract fails even when trace metrics are ungraded", () => {
  assert.deepEqual(
    performanceRunFailureReasons({
      run: {
        assertions: [
          { name: "semantic contract", passed: false },
          { name: "non-forced request", passed: true }
        ],
        outcome: "failed"
      },
      verdict: { status: "ungraded", reason: "report only" }
    }),
    ["semantic contract"]
  );
});

test("performance snapshot rejects newer Agent target migrations", () => {
  assert.deepEqual(
    findUnknownAgentTargetMigrationIDs(
      ["agent_targets_v1", "agent_targets_v2", "workspace_agent_activity_v2"],
      'const schemaMigrationAgentTargetsV1 = "agent_targets_v1"'
    ),
    ["agent_targets_v2"]
  );
});

test("performance snapshot focuses AgentGUI without selecting a session", () => {
  const source = {
    schemaVersion: 1,
    nodes: [
      {
        id: "files",
        data: { instanceId: "files", typeId: "workspace-files" }
      },
      {
        id: "agent",
        isMinimized: true,
        data: {
          instanceId: "agent",
          typeId: "agent-gui",
          snapshotNodeState: {
            agentTargetId: "local:codex",
            conversationRailCollapsed: true,
            lastActiveAgentSessionId: "session-1",
            lastActiveAgentSessionIdByAgentTargetId: {
              "local:codex": "session-1"
            }
          }
        }
      }
    ],
    nodeStack: ["agent", "files"],
    activeNodeId: "files"
  };

  const prepared = prepareWorkbenchSnapshotForPerformance(source);
  const agent = prepared.nodes.find((node) => node.id === "agent");
  assert.equal(prepared.activeNodeId, "agent");
  assert.deepEqual(prepared.nodeStack, ["files", "agent"]);
  assert.equal(agent.isMinimized, false);
  assert.deepEqual(agent.data.snapshotNodeState, {
    agentTargetId: "local:codex",
    conversationRailCollapsed: false,
    lastActiveAgentSessionId: null,
    lastActiveAgentSessionIdByAgentTargetId: {}
  });
  assert.equal(source.nodes[1].isMinimized, true);
});

test("provider switch target selection reuses selected target then chooses next", () => {
  assert.deepEqual(
    selectProviderSwitchTargets(
      [
        { targetID: "local:codex", disabled: false },
        { targetID: "local:claude-code", disabled: false },
        { targetID: "local:cursor", disabled: true }
      ],
      { selectedTargetID: "local:codex" }
    ),
    {
      sourceTargetID: "local:codex",
      targetTargetID: "local:claude-code"
    }
  );
});

test("provider switch summary separates semantic outcome from metrics", () => {
  assert.deepEqual(
    providerSwitchScenario.summarize(
      {
        sourceTargetID: "local:codex",
        targetTargetID: "local:claude-code",
        sectionCount: 30,
        itemCount: 120
      },
      { selected: true, sectionCount: 30, itemCount: 118 }
    ),
    {
      outcome: "passed",
      assertions: [
        { name: "target changed", passed: true },
        { name: "target selected", passed: true },
        { name: "rail contains sections", passed: true }
      ],
      details: [
        {
          label: "Provider switch",
          value: "local:codex → local:claude-code"
        },
        { label: "Sections", value: "30 → 30" },
        { label: "Items", value: "120 → 118" }
      ],
      stabilityCriterion:
        "five identical rail snapshots at 200 ms intervals, then two animation frames plus 250 ms settling tail"
    }
  );
});

test("session switch target selection keeps active source and chooses another", () => {
  assert.deepEqual(
    selectSessionSwitchTargets(
      [{ id: "session-1" }, { id: "session-2" }, { id: "session-3" }],
      "session-2"
    ),
    { sourceSessionID: "session-2", targetSessionID: "session-1" }
  );
});

test("session switch profiles its timeline geometry choke point", () => {
  assert.deepEqual(sessionSwitchScenario.profileFunctionNames, [
    "readTimelineGeometry"
  ]);
});

test("performance scenario registry exposes renderer and window scenarios", () => {
  assert.deepEqual(
    agentGuiPerformanceScenarios.map((scenario) => scenario.id),
    [
      "provider-switch",
      "session-switch",
      "provider-session-cycle",
      "virtualized-streaming",
      "concurrent-agent-streaming",
      "virtualized-scroll-locator",
      "virtualized-session-cycle",
      "virtualized-oversized-active-turn",
      "browser-behind-agent-gui-pixels",
      "rail-scope-reveal",
      "composer-input",
      "composer-overflow-resize",
      "workbench-dock-popup-preview",
      "workbench-fifty-window-stress",
      "workbench-window-drag",
      "workbench-window-lifecycle",
      "desktop-window-state",
      "provider-status-focus-refresh"
    ]
  );
  assert.equal(
    resolveAgentGuiPerformanceScenario("desktop-window-state").id,
    "desktop-window-state"
  );
  assert.throws(
    () => resolveAgentGuiPerformanceScenario("missing"),
    /unknown scenario: missing/
  );
});

test("concurrent streaming snapshot creates two visible session-scoped AgentGUI windows", () => {
  const prepared = prepareConcurrentAgentStreamingWorkbenchSnapshot(
    {
      activeNodeId: "agent-source",
      nodeStack: ["terminal-1", "agent-source"],
      nodes: [
        {
          id: "terminal-1",
          data: { typeId: "terminal" },
          frame: { x: 0, y: 0, width: 800, height: 600 }
        },
        {
          id: "agent-source",
          data: {
            instanceId: "source",
            typeId: "agent-gui",
            snapshotNodeState: { agentTargetId: "local:codex" }
          },
          frame: { x: 20, y: 30, width: 1400, height: 720 },
          isMinimized: true
        }
      ]
    },
    ["session-1", "session-2"]
  );
  const agents = prepared.nodes.filter(
    (node) => node.data.typeId === "agent-gui"
  );

  assert.equal(agents.length, 2);
  assert.deepEqual(
    agents.map((node) => node.data.snapshotNodeState.lastActiveAgentSessionId),
    ["session-1", "session-2"]
  );
  assert.equal(
    agents.every((node) => node.isMinimized === false),
    true
  );
  assert.equal(
    agents[0].frame.x + agents[0].frame.width < agents[1].frame.x,
    true
  );
  assert.equal(prepared.activeNodeId, agents[1].id);
});

test("AgentGUI window stress snapshot creates exact unique mounted windows", () => {
  const snapshot = prepareAgentGUIWindowStressSnapshot(
    {
      activeNodeId: "agent-gui:instance:source",
      nodeStack: ["terminal:1", "agent-gui:instance:source"],
      nodes: [
        {
          id: "terminal:1",
          data: { typeId: "terminal" },
          frame: { x: 0, y: 0, width: 800, height: 600 }
        },
        {
          id: "agent-gui:instance:source",
          data: {
            instanceId: "instance:source",
            instanceKey: null,
            typeId: "agent-gui"
          },
          frame: { x: 100, y: 50, width: 1200, height: 800 },
          isMinimized: true
        }
      ]
    },
    50
  );
  const agentGuiNodes = snapshot.nodes.filter(
    (node) => node.data.typeId === "agent-gui"
  );

  assert.equal(agentGuiNodes.length, 50);
  assert.equal(new Set(agentGuiNodes.map((node) => node.id)).size, 50);
  assert.equal(new Set(snapshot.nodeStack).size, 51);
  assert.equal(
    agentGuiNodes.every((node) => !node.isMinimized),
    true
  );
  assert.equal(snapshot.activeNodeId, agentGuiNodes.at(-1).id);
  assert.equal(
    snapshot.nodes.some((node) => node.id === "terminal:1"),
    true
  );
});

test("Dock popup preview snapshot creates 50 stress-layout windows", () => {
  const prepared = prepareWorkbenchDockPopupPreviewSnapshot({
    activeNodeId: "agent-source",
    nodeStack: ["terminal-1", "agent-source"],
    nodes: [
      {
        id: "terminal-1",
        data: { typeId: "terminal" },
        frame: { x: 0, y: 0, width: 800, height: 600 }
      },
      {
        id: "agent-source",
        data: {
          instanceId: "source",
          typeId: "agent-gui"
        },
        frame: { x: 80, y: 40, width: 1000, height: 700 },
        isMinimized: true,
        title: "Agent"
      }
    ]
  });
  const agents = prepared.snapshot.nodes.filter(
    (node) => node.data.typeId === "agent-gui"
  );

  assert.equal(agents.length, 50);
  assert.deepEqual(
    [agents[0].title, agents.at(-1).title],
    ["Dock Preview 1", "Dock Preview 50"]
  );
  assert.equal(
    agents.every((node) => node.isMinimized === false),
    true
  );
  assert.equal(new Set(agents.map((node) => node.id)).size, 50);
  assert.equal(prepared.snapshot.activeNodeId, agents.at(-1).id);
  assert.deepEqual(
    prepared.expectedNodeIDs,
    agents.map((node) => node.id)
  );
});

test("Dock popup preview trace rejects renderer tasks above 50 ms", () => {
  assert.equal(
    assessWorkbenchDockPopupPreviewTrace({
      timing: { maxLongTaskMs: 50 }
    }).assertions[0].passed,
    true
  );
  assert.equal(
    assessWorkbenchDockPopupPreviewTrace({
      timing: { maxLongTaskMs: 51 }
    }).assertions[0].passed,
    false
  );
});

test("workbench drag trace bounds background animation work", () => {
  assert.deepEqual(
    assessWorkbenchWindowDragTrace({
      inputEvents: { animationiteration: 20 },
      timing: { maxLongTaskMs: 50 }
    }).assertions,
    [
      { name: "drag animation iterations <= 20", passed: true },
      { name: "renderer task <= 50 ms", passed: true }
    ]
  );
  assert.equal(
    assessWorkbenchWindowDragTrace({
      inputEvents: { animationiteration: 21 },
      timing: { maxLongTaskMs: 51 }
    }).assertions[0].passed,
    false
  );
  assert.equal(
    assessWorkbenchWindowDragTrace({
      inputEvents: { animationiteration: 20 },
      timing: { maxLongTaskMs: 51 }
    }).assertions[1].passed,
    false
  );
});

test("composer input summary requires text, IME, and mention keyboard semantics", () => {
  const report = composerInputScenario.summarize(
    { dockComposer: true, editorReady: true, sessionID: "session-1" },
    {
      categoryChanged: true,
      collapsedGeometry: { buttonBottomOffset: 13, height: 56 },
      compositionEnds: 1,
      compositionStarts: 1,
      compositionUpdates: 3,
      expandedGeometry: { buttonBottomOffset: 13, height: 110 },
      highlightChanged: true,
      imeCommitted: true,
      inputEvents: 58,
      mentionClosed: true,
      mentionKeys: ["ArrowDown", "Tab", "Escape"],
      mentionOpened: true,
      shrunkGeometry: { buttonBottomOffset: 13, height: 56 }
    }
  );

  assert.equal(report.outcome, "passed");
  assert.deepEqual(
    report.assertions.map((assertion) => assertion.name),
    [
      "dock composer active",
      "four-line composer expanded",
      "composer shrank to one line",
      "action button stayed bottom-aligned",
      "per-character text input observed",
      "IME composition lifecycle observed",
      "IME text committed once",
      "@ mention panel opened",
      "mention selection moved",
      "mention category cycled",
      "mention keyboard events observed",
      "mention panel closed"
    ]
  );
});

test("provider status focus summary proves focus reuses the renderer snapshot", () => {
  const report = summarizeProviderStatusFocusRefresh(
    { providerCount: 6, startupRequestCount: 1 },
    { requests: [] }
  );

  assert.equal(report.outcome, "passed");
  assert.deepEqual(
    report.assertions.map((assertion) => assertion.name),
    [
      "startup provider snapshot loaded before capture",
      "focus uses the loaded renderer snapshot",
      "focus never forces provider detection"
    ]
  );
  assert.deepEqual(report.details.at(-1), {
    label: "Unexpected request durations",
    value: "none"
  });
});

test("all-process Time Profiler records every process without a time limit", () => {
  assert.deepEqual(buildAllProcessTimeProfileArgs("/tmp/profile.trace"), [
    "xctrace",
    "record",
    "--template",
    "Time Profiler",
    "--all-processes",
    "--no-prompt",
    "--output",
    "/tmp/profile.trace"
  ]);
});
