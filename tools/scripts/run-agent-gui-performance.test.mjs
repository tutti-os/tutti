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
import { composerInputScenario } from "./agent-gui-composer-performance-scenarios.mjs";
import { summarizeProviderStatusFocusRefresh } from "./agent-provider-status-performance-scenario.mjs";
import { buildAllProcessTimeProfileArgs } from "./all-process-time-profile.mjs";
import {
  applyScenarioAssessment,
  findUnknownAgentTargetMigrationIDs,
  performanceRunFailureReasons,
  prepareWorkbenchSnapshotForPerformance
} from "./run-agent-gui-performance.mjs";

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

test("performance scenario registry exposes renderer and window scenarios", () => {
  assert.deepEqual(
    agentGuiPerformanceScenarios.map((scenario) => scenario.id),
    [
      "provider-switch",
      "session-switch",
      "provider-session-cycle",
      "virtualized-streaming",
      "virtualized-scroll-locator",
      "rail-scope-reveal",
      "composer-input",
      "composer-overflow-resize",
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

test("composer input summary requires text, IME, and mention keyboard semantics", () => {
  const report = composerInputScenario.summarize(
    { dockComposer: true, editorReady: true, sessionID: "session-1" },
    {
      categoryChanged: true,
      compositionEnds: 1,
      compositionStarts: 1,
      compositionUpdates: 3,
      highlightChanged: true,
      imeCommitted: true,
      inputEvents: 58,
      mentionClosed: true,
      mentionKeys: ["ArrowDown", "Tab", "Escape"],
      mentionOpened: true
    }
  );

  assert.equal(report.outcome, "passed");
  assert.deepEqual(
    report.assertions.map((assertion) => assertion.name),
    [
      "dock composer active",
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
