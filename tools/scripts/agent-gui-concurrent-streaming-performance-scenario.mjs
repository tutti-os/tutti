import {
  evaluate,
  finishRendererScenario,
  markRenderer,
  startRendererScenario,
  waitForEvaluation
} from "./agent-gui-performance-helpers.mjs";
import { installCursorPerformanceFixture } from "./agent-gui-layout-performance-scenarios.mjs";
import {
  requiredScenarioData,
  scenarioSummary as summary,
  sqlString,
  startupWorkspaceID
} from "./agent-gui-performance-snapshot-helpers.mjs";

const scenarioID = "concurrent-agent-streaming";
const markers = {
  start: `tutti-perf:${scenarioID}:start`,
  submitted: `tutti-perf:${scenarioID}:submitted-observed`,
  bothMutated: `tutti-perf:${scenarioID}:both-transcripts-mutated`,
  settled: `tutti-perf:${scenarioID}:settled-observed`,
  end: `tutti-perf:${scenarioID}:end`
};

export const concurrentAgentStreamingScenario = {
  id: scenarioID,
  markers,
  milestones: [
    {
      key: "submitted",
      label: "both Agent prompts submitted",
      marker: markers.submitted
    },
    {
      key: "bothMutated",
      label: "both transcripts first rendered streamed text",
      marker: markers.bothMutated
    },
    {
      key: "settled",
      label: "both Agent streams settled",
      marker: markers.settled
    }
  ],
  prepareSnapshot: prepareConcurrentAgentStreamingSnapshot,
  prepare: prepareConcurrentAgentStreaming,
  execute: executeConcurrentAgentStreaming,
  profileFunctionNames: [
    "buildAgentGUIConversationModels",
    "buildCanonicalWorkspaceAgentDetailView",
    "advanceStreamingVisibleText"
  ],
  describe(prepared) {
    return `${prepared.nodeIDs.length} visible AgentGUI windows; ${prepared.sessionIDs.length} simultaneous deterministic ACP streams`;
  },
  summarize(prepared, result) {
    return summary(
      [
        {
          name: "two AgentGUI windows visible",
          passed: prepared.visibleWindowCount === 2
        },
        {
          name: "windows show different sessions",
          passed: new Set(prepared.activeSessionIDs).size === 2
        },
        {
          name: "submits entered working state together",
          passed: result.startedCount === 2 && result.submitDeltaMs <= 5
        },
        {
          name: "both transcripts rendered intermediate streamed text",
          passed: result.streamingTextSamples.every((count) => count >= 3)
        },
        {
          name: "both streams settled",
          passed: result.settledCount === 2
        }
      ],
      [
        { label: "Sessions", value: prepared.sessionIDs.join(", ") },
        {
          label: "Persisted turns",
          value: prepared.turnCounts.join(" + ")
        },
        {
          label: "Submit delta",
          value: `${result.submitDeltaMs.toFixed(3)} ms`
        },
        {
          label: "Mutation batches",
          value: result.mutationBatches.join(" + ")
        },
        {
          label: "DOM mutations",
          value: result.mutations.join(" + ")
        },
        {
          label: "Streaming text samples",
          value: result.streamingTextSamples.join(" + ")
        },
        {
          label: "Final streaming text lengths",
          value: result.finalStreamingTextLengths.join(" + ")
        },
        { label: "Provider", value: "two isolated fake Cursor ACP sessions" }
      ],
      "two non-overlapping AgentGUI bodies show different restored sessions; both forms submit in one renderer task; each local ACP stream renders at least three distinct intermediate text lengths, reaches the final chunk, and settles"
    );
  }
};

async function prepareConcurrentAgentStreamingSnapshot(context) {
  const environment = await installCursorPerformanceFixture(context);
  const workspaceID = await startupWorkspaceID(context);
  const candidates = await context.sqliteJSON(
    context.databasePath,
    `
SELECT s.agent_session_id AS sessionID, COUNT(t.turn_id) AS turnCount
FROM workspace_agent_sessions s
LEFT JOIN workspace_agent_turns t
  ON t.workspace_id = s.workspace_id
 AND t.agent_session_id = s.agent_session_id
WHERE s.workspace_id = '${sqlString(workspaceID)}'
  AND s.deleted_at_unix_ms = 0
  AND s.origin = 'WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME'
  AND s.session_kind = 'root'
  AND s.active_turn_id IS NULL
GROUP BY s.agent_session_id
ORDER BY COUNT(t.turn_id) DESC, s.agent_session_id ASC
LIMIT 2;
`
  );
  if (candidates.length !== 2) {
    throw new Error(
      "concurrent-agent-streaming requires two settled root sessions in the startup workspace"
    );
  }
  const snapshotRows = await context.sqliteJSON(
    context.databasePath,
    `
SELECT snapshot_json AS snapshotJSON
FROM workspace_workbench_snapshots
WHERE workspace_id = '${sqlString(workspaceID)}'
LIMIT 1;
`
  );
  const snapshot = JSON.parse(snapshotRows[0]?.snapshotJSON ?? "null");
  const preparedSnapshot = prepareConcurrentAgentStreamingWorkbenchSnapshot(
    snapshot,
    candidates.map((candidate) => candidate.sessionID)
  );
  const now = Date.now();
  const sessionUpdates = candidates
    .map(
      (candidate, index) => `
UPDATE workspace_agent_sessions
SET agent_target_id = 'local:cursor',
    provider = 'cursor',
    provider_session_id = 'tutti-perf-cursor-session-${index + 1}',
    model = '',
    settings_json = '{}',
    cwd = '${sqlString(context.workspaceRoot)}',
    rail_section_kind = 'conversations',
    rail_project_path = '',
    rail_section_key = 'conversations',
    session_metadata_json = json_set(
      session_metadata_json,
      '$.visible', json('true'),
      '$.imported', json('false')
    ),
    internal_runtime_context_json = '{}',
    updated_at_unix_ms = ${now + index}
WHERE workspace_id = '${sqlString(workspaceID)}'
  AND agent_session_id = '${sqlString(candidate.sessionID)}';`
    )
    .join("\n");
  await context.sqliteExec(
    context.databasePath,
    `
PRAGMA foreign_keys = ON;
UPDATE agent_targets
SET enabled = 1, updated_at_ms = ${now}
WHERE id = 'local:cursor';
${sessionUpdates}
UPDATE workspace_workbench_snapshots
SET snapshot_json = '${sqlString(JSON.stringify(preparedSnapshot))}'
WHERE workspace_id = '${sqlString(workspaceID)}';
`
  );
  return {
    data: {
      nodeIDs: preparedSnapshot.nodeStack.slice(-2),
      sessionIDs: candidates.map((candidate) => candidate.sessionID),
      turnCounts: candidates.map((candidate) => Number(candidate.turnCount)),
      workspaceID
    },
    environment
  };
}

export function prepareConcurrentAgentStreamingWorkbenchSnapshot(
  snapshot,
  sessionIDs
) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.nodes) ||
    !Array.isArray(sessionIDs) ||
    sessionIDs.length !== 2 ||
    sessionIDs.some((sessionID) => !String(sessionID).trim())
  ) {
    throw new Error("invalid concurrent Agent streaming snapshot input");
  }
  const template =
    snapshot.nodes.find(
      (node) =>
        node?.id === snapshot.activeNodeId && node?.data?.typeId === "agent-gui"
    ) ?? snapshot.nodes.find((node) => node?.data?.typeId === "agent-gui");
  if (!template) {
    throw new Error("concurrent Agent streaming snapshot has no AgentGUI node");
  }
  const retainedNodes = snapshot.nodes.filter(
    (node) => node?.data?.typeId !== "agent-gui"
  );
  const gap = 16;
  const windowWidth = Math.max(560, (template.frame.width - gap) / 2);
  const agentNodes = sessionIDs.map((sessionID, index) => {
    const instanceID = `agent-gui:instance:perf-concurrent-${index + 1}`;
    const node = structuredClone(template);
    node.id = `agent-gui:${instanceID}`;
    node.data = {
      ...node.data,
      instanceId: instanceID,
      instanceKey: null,
      snapshotNodeState: {
        ...(node.data?.snapshotNodeState ?? {}),
        agentTargetId: "local:cursor",
        conversationRailCollapsed: true,
        lastActiveAgentSessionId: sessionID,
        lastActiveAgentSessionIdByAgentTargetId: {
          "local:cursor": sessionID
        }
      }
    };
    node.frame = {
      ...template.frame,
      x: template.frame.x + index * (windowWidth + gap),
      width: windowWidth
    };
    node.isMinimized = false;
    return node;
  });
  return {
    ...snapshot,
    activeNodeId: agentNodes[1].id,
    nodeStack: [
      ...retainedNodes.map((node) => node.id),
      ...agentNodes.map((node) => node.id)
    ],
    nodes: [...retainedNodes, ...agentNodes]
  };
}

async function prepareConcurrentAgentStreaming(context, options) {
  const fixture = requiredScenarioData(context, scenarioID);
  const ready = await waitForEvaluation(
    context.pageClient,
    `(() => {
      const expected = ${JSON.stringify(fixture.nodeIDs)};
      const windows = expected.map((nodeID) => {
        const shell = document.querySelector(
          '[data-workbench-window-id="' + CSS.escape(nodeID) + '"]'
        );
        const body = shell?.querySelector('[data-agent-gui-visible="true"]');
        const activeRow = shell?.querySelector(
          '[data-testid^="agent-gui-conversation-item-"][data-active="true"]'
        );
        const editor = shell?.querySelector(
          '#agent-gui-detail [contenteditable="true"][role="textbox"]'
        );
        return {
          activeSessionID:
            activeRow?.getAttribute('data-testid')
              ?.slice('agent-gui-conversation-item-'.length) ?? null,
          editorReady:
            editor instanceof HTMLElement &&
            editor.getAttribute('aria-disabled') !== 'true',
          visible:
            body instanceof HTMLElement &&
            getComputedStyle(body).contentVisibility !== 'hidden'
        };
      });
      return {
        ready:
          windows.length === 2 &&
          windows.every((windowState) =>
            windowState.visible &&
            windowState.editorReady &&
            windowState.activeSessionID
          ),
        windows
      };
    })()`,
    options.timeoutMs,
    "two visible AgentGUI sessions with enabled composers",
    100
  );
  return {
    ...fixture,
    activeSessionIDs: ready.windows.map(
      (windowState) => windowState.activeSessionID
    ),
    visibleWindowCount: ready.windows.filter(
      (windowState) => windowState.visible
    ).length
  };
}

async function executeConcurrentAgentStreaming(context, prepared, options) {
  const { pageClient } = context;
  await evaluate(
    pageClient,
    `(() => {
      const nodeIDs = ${JSON.stringify(prepared.nodeIDs)};
      const windows = nodeIDs.map((nodeID, index) => {
        const shell = document.querySelector(
          '[data-workbench-window-id="' + CSS.escape(nodeID) + '"]'
        );
        const timeline = shell?.querySelector('[data-testid="agent-gui-timeline"]');
        const editor = shell?.querySelector(
          '#agent-gui-detail [contenteditable="true"][role="textbox"]'
        );
        if (!(timeline instanceof HTMLElement) || !(editor instanceof HTMLElement)) {
          throw new Error('concurrent Agent streaming surface is unavailable');
        }
        editor.focus();
        document.execCommand('selectAll', false);
        if (
          !document.execCommand(
            'insertText',
            false,
            'Concurrent Agent streaming fixture ' + (index + 1)
          )
        ) {
          throw new Error('could not enter concurrent Agent prompt');
        }
        return { editor, timeline };
      });
      window.__tuttiPerfConcurrentAgentStreaming = {
        bothMutated: false,
        observers: [],
        windows
      };
      return true;
    })()`
  );
  await waitForEvaluation(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfConcurrentAgentStreaming;
      return {
        ready: Boolean(
          state?.windows?.length === 2 &&
          state.windows.every(({ editor }) => {
            const submit = editor.closest('form')?.querySelector(
              'button[type="submit"]'
            );
            return submit instanceof HTMLButtonElement && !submit.disabled;
          })
        )
      };
    })()`,
    options.timeoutMs,
    "two enabled Agent composer submit buttons",
    25
  );
  await startRendererScenario(pageClient, markers.start);
  await evaluate(
    pageClient,
    `(() => {
      const runtime = window.__tuttiPerfConcurrentAgentStreaming;
      runtime.windows.forEach((windowState) => {
        windowState.state = {
          firstMutation: false,
          mutationBatches: 0,
          mutations: 0,
          streamingTextLengths: []
        };
        const sampleStreamingText = () => {
          const text =
            [...windowState.timeline.querySelectorAll(
              '.agent-gui-conversation__assistant-message-flow'
            )]
              .map((element) => element.textContent ?? '')
              .find((value) =>
                value.includes('Virtualized streaming fixture chunk')
              ) ?? '';
          const lengths = windowState.state.streamingTextLengths;
          if (text.length > 0 && lengths.at(-1) !== text.length) {
            lengths.push(text.length);
          }
          return text;
        };
        windowState.sampleStreamingText = sampleStreamingText;
        const observer = new MutationObserver((records) => {
          windowState.state.mutationBatches += 1;
          windowState.state.mutations += records.length;
          windowState.state.firstMutation = true;
          sampleStreamingText();
          if (
            runtime.windows.every(
              (candidate) =>
                candidate.state.firstMutation &&
                candidate.state.streamingTextLengths.length > 0
            ) &&
            !runtime.bothMutated
          ) {
            runtime.bothMutated = true;
            console.timeStamp(${JSON.stringify(markers.bothMutated)});
          }
        });
        observer.observe(windowState.timeline, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true
        });
        runtime.observers.push(observer);
      });
      return true;
    })()`
  );
  const submit = await evaluate(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfConcurrentAgentStreaming;
      const submittedAt = [];
      for (const { editor } of state.windows) {
        const form = editor.closest('form');
        if (!(form instanceof HTMLFormElement)) {
          throw new Error('concurrent Agent composer form is unavailable');
        }
        submittedAt.push(performance.now());
        form.requestSubmit();
      }
      return {
        submitDeltaMs: submittedAt[1] - submittedAt[0]
      };
    })()`
  );
  await markRenderer(pageClient, markers.submitted);
  const started = await waitForEvaluation(
    pageClient,
    `(() => {
      const nodeIDs = ${JSON.stringify(prepared.nodeIDs)};
      const startedCount = nodeIDs.filter((nodeID) => {
        const shell = document.querySelector(
          '[data-workbench-window-id="' + CSS.escape(nodeID) + '"]'
        );
        return shell?.querySelector(
          '[data-testid="agent-gui-composer-stop-symbol"]'
        );
      }).length;
      return { ready: startedCount === 2, startedCount };
    })()`,
    options.timeoutMs,
    "both Agent streams working",
    25
  );
  const settled = await waitForEvaluation(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfConcurrentAgentStreaming;
      const nodeIDs = ${JSON.stringify(prepared.nodeIDs)};
      const settledCount = nodeIDs.filter((nodeID) => {
        const shell = document.querySelector(
          '[data-workbench-window-id="' + CSS.escape(nodeID) + '"]'
        );
        return !shell?.querySelector(
          '[data-testid="agent-gui-composer-stop-symbol"]'
        );
      }).length;
      const mutationBatches =
        state?.windows?.map(({ state: windowState }) =>
          windowState.mutationBatches
        ) ?? [];
      const mutations =
        state?.windows?.map(({ state: windowState }) =>
          windowState.mutations
        ) ?? [];
      const streamingTextSamples =
        state?.windows?.map(({ state: windowState }) =>
          windowState.streamingTextLengths.length
        ) ?? [];
      const finalStreamingTexts =
        state?.windows?.map((windowState) =>
          windowState.sampleStreamingText()
        ) ?? [];
      return {
        ready:
          settledCount === 2 &&
          mutationBatches.length === 2 &&
          mutationBatches.every((count) => count >= 8) &&
          streamingTextSamples.every((count) => count >= 3) &&
          finalStreamingTexts.every((text) =>
            text.includes('Virtualized streaming fixture chunk 48')
          ),
        finalStreamingTextLengths: finalStreamingTexts.map(
          (text) => text.length
        ),
        mutationBatches,
        mutations,
        streamingTextSamples,
        settledCount
      };
    })()`,
    options.timeoutMs,
    "both concurrent Agent streams settled",
    50
  );
  await markRenderer(pageClient, markers.settled);
  await evaluate(
    pageClient,
    `(() => {
      window.__tuttiPerfConcurrentAgentStreaming?.observers?.forEach(
        (observer) => observer.disconnect()
      );
      return true;
    })()`
  );
  await finishRendererScenario(pageClient, markers.end);
  return {
    mutationBatches: settled.mutationBatches,
    mutations: settled.mutations,
    finalStreamingTextLengths: settled.finalStreamingTextLengths,
    streamingTextSamples: settled.streamingTextSamples,
    settledCount: settled.settledCount,
    startedCount: started.startedCount,
    submitDeltaMs: submit.submitDeltaMs
  };
}
