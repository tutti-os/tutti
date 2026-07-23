import {
  requiredScenarioData,
  scenarioSummary as summary,
  sqlString,
  startupWorkspaceID,
  updateAgentGUISnapshot
} from "./agent-gui-performance-snapshot-helpers.mjs";
import {
  evaluate,
  finishRendererScenario,
  markRenderer,
  startRendererScenario,
  waitForEvaluation
} from "./agent-gui-performance-helpers.mjs";

const editorSelector =
  '#agent-gui-detail [contenteditable="true"][role="textbox"]';
const paletteSelector = '[data-testid="agent-gui-mention-palette-surface"]';
const ordinaryText =
  "Measure AgentGUI composer input one character at a time. ";
const multilineText = "2\n3\n4\n5";
const imeCandidates = ["x", "xing", "性能"];
const imeCommittedText = "性能";

const composerInputMarkers = {
  start: "tutti-perf:composer-input:start",
  multilineExpanded: "tutti-perf:composer-input:multiline-expanded-observed",
  multilineShrunk: "tutti-perf:composer-input:multiline-shrunk-observed",
  textEntered: "tutti-perf:composer-input:text-entered-observed",
  imeComposing: "tutti-perf:composer-input:ime-composing-observed",
  imeCommitted: "tutti-perf:composer-input:ime-committed-observed",
  mentionOpened: "tutti-perf:composer-input:mention-opened-observed",
  mentionNavigated: "tutti-perf:composer-input:mention-navigated-observed",
  mentionClosed: "tutti-perf:composer-input:mention-closed-observed",
  end: "tutti-perf:composer-input:end"
};

export const composerInputScenario = {
  id: "composer-input",
  markers: composerInputMarkers,
  milestones: [
    {
      key: "multilineExpanded",
      label: "four-line composer expanded",
      marker: composerInputMarkers.multilineExpanded
    },
    {
      key: "multilineShrunk",
      label: "composer shrunk to one line",
      marker: composerInputMarkers.multilineShrunk
    },
    {
      key: "textEntered",
      label: "per-character text entered",
      marker: composerInputMarkers.textEntered
    },
    {
      key: "imeComposing",
      label: "IME composition updated",
      marker: composerInputMarkers.imeComposing
    },
    {
      key: "imeCommitted",
      label: "IME composition committed",
      marker: composerInputMarkers.imeCommitted
    },
    {
      key: "mentionOpened",
      label: "@ mention panel opened",
      marker: composerInputMarkers.mentionOpened
    },
    {
      key: "mentionNavigated",
      label: "mention highlight and category changed",
      marker: composerInputMarkers.mentionNavigated
    },
    {
      key: "mentionClosed",
      label: "mention panel closed",
      marker: composerInputMarkers.mentionClosed
    }
  ],
  prepareSnapshot: prepareComposerInputSnapshot,
  prepare: prepareComposerInput,
  execute: executeComposerInput,
  describe(prepared) {
    return `${prepared.sessionID}; ${Array.from(multilineText).length} multiline inserts + shrink + ${Array.from(ordinaryText).length} text inserts + ${imeCandidates.length} IME updates + @ keyboard navigation`;
  },
  summarize(prepared, result) {
    return summary(
      [
        { name: "dock composer active", passed: prepared.dockComposer },
        {
          name: "four-line composer expanded",
          passed:
            result.expandedGeometry.height > result.collapsedGeometry.height + 1
        },
        {
          name: "composer shrank to one line",
          passed:
            Math.abs(
              result.shrunkGeometry.height - result.collapsedGeometry.height
            ) <= 1
        },
        {
          name: "action button stayed bottom-aligned",
          passed:
            Math.abs(
              result.expandedGeometry.buttonBottomOffset -
                result.collapsedGeometry.buttonBottomOffset
            ) <= 1 &&
            Math.abs(
              result.shrunkGeometry.buttonBottomOffset -
                result.collapsedGeometry.buttonBottomOffset
            ) <= 1
        },
        {
          name: "per-character text input observed",
          passed: result.inputEvents >= Array.from(ordinaryText).length
        },
        {
          name: "IME composition lifecycle observed",
          passed:
            result.compositionStarts > 0 &&
            result.compositionUpdates >= imeCandidates.length &&
            result.compositionEnds > 0
        },
        { name: "IME text committed once", passed: result.imeCommitted },
        { name: "@ mention panel opened", passed: result.mentionOpened },
        {
          name: "mention selection moved",
          passed: result.highlightChanged
        },
        { name: "mention category cycled", passed: result.categoryChanged },
        {
          name: "mention keyboard events observed",
          passed: result.mentionKeys.join(",") === "ArrowDown,Tab,Escape"
        },
        { name: "mention panel closed", passed: result.mentionClosed }
      ],
      [
        { label: "Session", value: prepared.sessionID },
        {
          label: "Composer heights",
          value: `${result.collapsedGeometry.height.toFixed(1)} -> ${result.expandedGeometry.height.toFixed(1)} -> ${result.shrunkGeometry.height.toFixed(1)} px`
        },
        {
          label: "Text inserts",
          value: String(
            Array.from(multilineText).length + Array.from(ordinaryText).length
          )
        },
        { label: "Input events", value: String(result.inputEvents) },
        {
          label: "IME events",
          value: `${result.compositionStarts} start / ${result.compositionUpdates} update / ${result.compositionEnds} end`
        },
        {
          label: "Mention keys",
          value: result.mentionKeys.join(" -> ")
        }
      ],
      "CDP expands the composer through explicit newline transactions, deletes back to one line, injects ordinary text character by character, drives one real IME composition lifecycle, then verifies @ keyboard navigation"
    );
  }
};

async function prepareComposerInputSnapshot(context) {
  const workspaceID = await startupWorkspaceID(context);
  const candidates = await context.sqliteJSON(
    context.databasePath,
    `
SELECT s.agent_session_id AS sessionID,
       s.agent_target_id AS targetID
FROM workspace_agent_sessions s
JOIN agent_targets t ON t.id = s.agent_target_id
WHERE s.workspace_id = '${sqlString(workspaceID)}'
  AND s.deleted_at_unix_ms = 0
  AND s.session_kind = 'root'
  AND s.active_turn_id IS NULL
  AND t.enabled = 1
ORDER BY s.updated_at_unix_ms DESC, s.agent_session_id ASC
LIMIT 1;
`
  );
  const candidate = candidates[0];
  if (!candidate?.sessionID || !candidate.targetID) {
    throw new Error(
      "composer-input requires one settled root session for an enabled Agent target"
    );
  }
  await updateAgentGUISnapshot(context, (state) => ({
    ...state,
    agentTargetId: candidate.targetID,
    conversationRailCollapsed: false,
    lastActiveAgentSessionId: candidate.sessionID,
    lastActiveAgentSessionIdByAgentTargetId: {
      ...(state.lastActiveAgentSessionIdByAgentTargetId ?? {}),
      [candidate.targetID]: candidate.sessionID
    }
  }));
  return {
    data: {
      sessionID: candidate.sessionID,
      targetID: candidate.targetID,
      workspaceID
    }
  };
}

async function prepareComposerInput(context, options) {
  const fixture = requiredScenarioData(context, "composer-input");
  const ready = await waitForEvaluation(
    context.pageClient,
    `(() => {
      const editor = document.querySelector(${JSON.stringify(editorSelector)});
      const activeSession = document.querySelector(${JSON.stringify(`[data-testid="agent-gui-conversation-item-${fixture.sessionID}"]`)});
      const dockComposer = Boolean(editor?.closest('.agent-gui-node__composer-prompt-input-area'));
      return {
        ready: editor instanceof HTMLElement && editor.getAttribute('contenteditable') === 'true' && activeSession?.dataset.active === 'true' && dockComposer,
        dockComposer,
        editorReady: editor instanceof HTMLElement
      };
    })()`,
    options.timeoutMs,
    "enabled AgentGUI composer editor"
  );
  await evaluate(
    context.pageClient,
    `(() => {
      const editor = document.querySelector(${JSON.stringify(editorSelector)});
      if (!(editor instanceof HTMLElement)) throw new Error('composer editor is unavailable');
      editor.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      return true;
    })()`
  );
  await waitForEditorText(context.pageClient, "", options.timeoutMs);
  return {
    dockComposer: ready.dockComposer,
    editorReady: ready.editorReady,
    sessionID: fixture.sessionID,
    targetID: fixture.targetID
  };
}

async function executeComposerInput(context, _prepared, options) {
  const { pageClient } = context;
  await installComposerInputCounters(pageClient);
  await startRendererScenario(pageClient, composerInputMarkers.start);

  const collapsedGeometry = await readComposerGeometry(pageClient);
  for (const character of Array.from(multilineText)) {
    await pageClient.send("Input.insertText", { text: character });
  }
  await waitForEditorText(pageClient, multilineText, options.timeoutMs);
  const expandedGeometry = await waitForComposerGeometry(
    pageClient,
    `height > ${JSON.stringify(collapsedGeometry.height + 1)} && Math.abs(height - targetHeight) <= 1`,
    options.timeoutMs,
    "four-line composer expansion"
  );
  await markRenderer(pageClient, composerInputMarkers.multilineExpanded);

  await clearComposerEditor(pageClient);
  await waitForEditorText(pageClient, "", options.timeoutMs);
  const shrunkGeometry = await waitForComposerGeometry(
    pageClient,
    `Math.abs(height - ${JSON.stringify(collapsedGeometry.height)}) <= 1`,
    options.timeoutMs,
    "composer shrink to one line"
  );
  await markRenderer(pageClient, composerInputMarkers.multilineShrunk);

  for (const character of Array.from(ordinaryText)) {
    await pageClient.send("Input.insertText", { text: character });
  }
  await waitForEditorText(pageClient, ordinaryText, options.timeoutMs);
  await markRenderer(pageClient, composerInputMarkers.textEntered);

  for (const candidate of imeCandidates) {
    await pageClient.send("Input.imeSetComposition", {
      text: candidate,
      selectionStart: candidate.length,
      selectionEnd: candidate.length
    });
  }
  await waitForEditorText(
    pageClient,
    `${ordinaryText}${imeCommittedText}`,
    options.timeoutMs
  );
  await markRenderer(pageClient, composerInputMarkers.imeComposing);
  await pageClient.send("Input.insertText", { text: imeCommittedText });
  const committed = await waitForEditorText(
    pageClient,
    `${ordinaryText}${imeCommittedText}`,
    options.timeoutMs
  );
  await markRenderer(pageClient, composerInputMarkers.imeCommitted);

  await pageClient.send("Input.insertText", { text: " @" });
  const opened = await waitForMentionState(
    pageClient,
    "Boolean(palette)",
    options.timeoutMs,
    "open @ mention panel"
  );
  await markRenderer(pageClient, composerInputMarkers.mentionOpened);

  const initialHighlight = opened.highlightedIndex;
  const initialCategory = opened.activeCategoryIndex;
  await dispatchKey(pageClient, "ArrowDown", "ArrowDown", 40);
  const highlighted = await waitForMentionState(
    pageClient,
    `Boolean(palette) && highlightedIndex !== ${JSON.stringify(initialHighlight)}`,
    options.timeoutMs,
    "changed mention highlight"
  );
  await dispatchKey(pageClient, "Tab", "Tab", 9);
  const navigated = await waitForMentionState(
    pageClient,
    `Boolean(palette) && activeCategoryIndex !== ${JSON.stringify(initialCategory)}`,
    options.timeoutMs,
    "changed mention category"
  );
  await markRenderer(pageClient, composerInputMarkers.mentionNavigated);

  await dispatchKey(pageClient, "Escape", "Escape", 27);
  const closed = await waitForMentionState(
    pageClient,
    "!palette",
    options.timeoutMs,
    "closed mention panel"
  );
  await markRenderer(pageClient, composerInputMarkers.mentionClosed);
  const counters = await readAndRemoveComposerInputCounters(pageClient);
  await finishRendererScenario(pageClient, composerInputMarkers.end);

  return {
    ...counters,
    collapsedGeometry,
    expandedGeometry,
    shrunkGeometry,
    categoryChanged: navigated.activeCategoryIndex !== initialCategory,
    highlightChanged: highlighted.highlightedIndex !== initialHighlight,
    imeCommitted:
      committed.text === `${ordinaryText}${imeCommittedText}` &&
      countOccurrences(committed.text, imeCommittedText) === 1,
    mentionClosed: closed.palettePresent === false,
    mentionOpened: opened.palettePresent === true
  };
}

async function clearComposerEditor(client) {
  await evaluate(
    client,
    `(() => {
      const editor = document.querySelector(${JSON.stringify(editorSelector)});
      if (!(editor instanceof HTMLElement)) throw new Error('composer editor is unavailable');
      editor.focus();
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      return true;
    })()`
  );
}

async function readComposerGeometry(client) {
  return evaluate(client, composerGeometryExpression("true"));
}

async function waitForComposerGeometry(client, predicate, timeoutMs, label) {
  return waitForEvaluation(
    client,
    composerGeometryExpression(predicate),
    timeoutMs,
    label,
    25
  );
}

function composerGeometryExpression(predicate) {
  return `(() => {
    const editor = document.querySelector(${JSON.stringify(editorSelector)});
    const inputArea = editor?.closest('.agent-gui-node__composer-prompt-input-area');
    const actionButton = inputArea?.querySelector('.agent-gui-node__composer-send-button, .agent-gui-node__composer-stop-button');
    if (!(inputArea instanceof HTMLElement) || !(actionButton instanceof HTMLElement)) {
      return { ready: false, buttonBottomOffset: -1, height: -1, targetHeight: -1 };
    }
    const inputRect = inputArea.getBoundingClientRect();
    const buttonRect = actionButton.getBoundingClientRect();
    const height = inputRect.height;
    const targetHeight = Number.parseFloat(
      inputArea.style.getPropertyValue('--agent-gui-composer-input-height')
    );
    const buttonBottomOffset = inputRect.bottom - buttonRect.bottom;
    return {
      ready: ${predicate},
      buttonBottomOffset,
      height,
      targetHeight
    };
  })()`;
}

async function installComposerInputCounters(client) {
  await evaluate(
    client,
    `(() => {
      const editor = document.querySelector(${JSON.stringify(editorSelector)});
      if (!(editor instanceof HTMLElement)) throw new Error('composer editor is unavailable');
      const state = {
        compositionStarts: 0,
        compositionUpdates: 0,
        compositionEnds: 0,
        inputEvents: 0,
        mentionKeys: []
      };
      const handlers = {
        compositionstart: () => { state.compositionStarts += 1; },
        compositionupdate: () => { state.compositionUpdates += 1; },
        compositionend: () => { state.compositionEnds += 1; },
        input: () => { state.inputEvents += 1; }
      };
      for (const [type, handler] of Object.entries(handlers)) editor.addEventListener(type, handler, true);
      const keydown = (event) => {
        if (event.target === editor && ['ArrowDown', 'Tab', 'Escape'].includes(event.key)) state.mentionKeys.push(event.key);
      };
      document.addEventListener('keydown', keydown, true);
      window.__tuttiPerfComposerInput = { editor, handlers, keydown, state };
      editor.focus();
      return true;
    })()`
  );
}

async function readAndRemoveComposerInputCounters(client) {
  return evaluate(
    client,
    `(() => {
      const owner = window.__tuttiPerfComposerInput;
      if (!owner) throw new Error('composer input counters are unavailable');
      for (const [type, handler] of Object.entries(owner.handlers)) owner.editor.removeEventListener(type, handler, true);
      document.removeEventListener('keydown', owner.keydown, true);
      delete window.__tuttiPerfComposerInput;
      return owner.state;
    })()`
  );
}

async function waitForEditorText(client, expected, timeoutMs) {
  return waitForEvaluation(
    client,
    `(() => {
      const editor = document.querySelector(${JSON.stringify(editorSelector)});
      const text = editor
        ? [...editor.children].map((block) => block.textContent ?? '').join('\\n')
        : '';
      return { ready: text === ${JSON.stringify(expected)}, text };
    })()`,
    timeoutMs,
    `composer text ${JSON.stringify(expected)}`,
    25
  );
}

async function waitForMentionState(client, predicate, timeoutMs, label) {
  return waitForEvaluation(
    client,
    `(() => {
      const palette = document.querySelector(${JSON.stringify(paletteSelector)});
      const highlighted = palette?.querySelector('[data-highlighted]') ?? null;
      const highlightable = palette ? [...palette.querySelectorAll('[role="option"], button[data-highlighted]')] : [];
      const activeCategory = palette?.querySelector('[role="tab"][aria-selected="true"]') ?? null;
      const categories = palette ? [...palette.querySelectorAll('[role="tab"]')] : [];
      const activeCategoryIndex = activeCategory ? categories.indexOf(activeCategory) : -1;
      const highlightedIndex = highlighted ? highlightable.indexOf(highlighted) : -1;
      return {
        ready: ${predicate},
        activeCategoryIndex,
        highlightedIndex,
        palettePresent: Boolean(palette)
      };
    })()`,
    timeoutMs,
    label,
    25
  );
}

async function dispatchKey(client, key, code, virtualKeyCode) {
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  });
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}
