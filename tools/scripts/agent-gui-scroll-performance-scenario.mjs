import {
  evaluate,
  finishRendererScenario,
  markRenderer,
  startRendererScenario,
  waitForEvaluation
} from "./agent-gui-performance-helpers.mjs";
import {
  prepareVirtualizedTranscript,
  prepareVirtualizedTranscriptSnapshot
} from "./agent-gui-layout-performance-scenarios.mjs";
import { scenarioSummary } from "./agent-gui-performance-snapshot-helpers.mjs";

const markers = {
  start: "tutti-perf:virtualized-scroll-locator:start",
  scrolled: "tutti-perf:virtualized-scroll-locator:scrolled-observed",
  stable: "tutti-perf:virtualized-scroll-locator:stable-observed",
  end: "tutti-perf:virtualized-scroll-locator:end"
};
const scrollDurationMs = 10_000;
const minimumScrollDurationMs = 9_000;
const minimumViewportTravel = 8;
const forbiddenProfileFunctions = [
  "EditorView",
  "hasSelection",
  "selectionToDOM",
  "updateStateInner"
];

export const virtualizedScrollLocatorScenario = {
  id: "virtualized-scroll-locator",
  markers,
  milestones: [
    {
      key: "scrolled",
      label: "monotonic transcript scroll completed",
      marker: markers.scrolled
    },
    {
      key: "stable",
      label: "locator selection stable",
      marker: markers.stable
    }
  ],
  profileFunctionNames: [...forbiddenProfileFunctions, "captureScrollAnchor"],
  prepareSnapshot(context) {
    return prepareVirtualizedTranscriptSnapshot(context, {
      richTextFixture: true
    });
  },
  prepare(context, options) {
    return prepareVirtualizedTranscript(
      context,
      options,
      "virtualized-scroll-locator"
    );
  },
  execute: executeVirtualizedScrollLocator,
  describe(prepared) {
    return `${prepared.sessionID}; ${prepared.turnCount} persisted turns; ${scrollDurationMs / 1_000}s monotonic upward scroll`;
  },
  summarize(prepared, result) {
    return scenarioSummary(
      [
        { name: "transcript virtualized", passed: prepared.virtualized },
        {
          name: "rich-text fixture has at least four messages",
          passed: prepared.richTextMessageCount >= 4
        },
        {
          name: "rich-text fixture has three mentions per message",
          passed: prepared.richTextMentionsPerMessage === 3
        },
        {
          name: "rich-text fixture has eight paragraphs per message",
          passed: prepared.richTextParagraphsPerMessage === 8
        },
        { name: "timeline scrolled upward", passed: result.moved },
        {
          name: "timeline traveled at least eight viewports",
          passed: result.travel >= result.viewportHeight * minimumViewportTravel
        },
        {
          name: "continuous scroll lasted at least nine seconds",
          passed: result.elapsedMs >= minimumScrollDurationMs
        },
        {
          name: "historical transcript created no interactive editor",
          passed: result.maxHistoricalInteractiveNodes === 0
        },
        {
          name: "mounted window exercised static rich text",
          passed: result.maxStaticRichTextNodes > 0
        },
        {
          name: "mounted window exercised mention chips",
          passed: result.maxMountedMentions > 0
        },
        { name: "locator selected a message", passed: result.selected },
        {
          name: "locator selection matches viewport turn",
          passed: result.matchesViewportTurn
        },
        {
          name: "locator selection never reversed",
          passed: result.reversedTransitions === 0
        },
        {
          name: "locator selection never returned",
          passed: result.returnedTransitions === 0
        },
        { name: "locator settled", passed: result.stable }
      ],
      [
        { label: "Session", value: prepared.sessionID },
        { label: "Persisted turns", value: String(prepared.turnCount) },
        {
          label: "Rich-text fixture",
          value: `${prepared.richTextMessageCount} messages × ${prepared.richTextParagraphsPerMessage} paragraphs × ${prepared.richTextMentionsPerMessage} mentions`
        },
        {
          label: "Scroll duration",
          value: `${Math.round(result.elapsedMs)} ms over ${result.frameCount} frames`
        },
        {
          label: "Scroll range",
          value: `${Math.round(result.startScrollTop)} → ${Math.round(result.endScrollTop)}`
        },
        {
          label: "Viewport travel",
          value: `${(result.travel / result.viewportHeight).toFixed(1)}×`
        },
        {
          label: "Max mounted static rich text / mentions",
          value: `${result.maxStaticRichTextNodes} / ${result.maxMountedMentions}`
        },
        {
          label: "Selected indexes",
          value: result.selectedIndexes.join(" → ") || "none"
        },
        {
          label: "Expected final index",
          value: String(result.expectedSelectedIndex)
        },
        {
          label: "Initial virtual turns",
          value: result.startVirtualTurnKeys.join(", ") || "none"
        },
        {
          label: "Final virtual turns",
          value: result.endVirtualTurnKeys.join(", ") || "none"
        },
        {
          label: "Reversed transitions",
          value: String(result.reversedTransitions)
        },
        {
          label: "Returned transitions",
          value: String(result.returnedTransitions)
        }
      ],
      "a ten-second monotonic upward scroll traverses at least eight viewport heights, keeps historical content non-editable, produces a non-increasing locator index sequence, then reaches five identical settled snapshots"
    );
  },
  assessTrace(summary) {
    const profileSamples = summary.cpuProfile.functionSamples;
    return {
      assertions: [
        {
          name: "CPU profile samples > 0",
          passed: summary.cpuProfile.sampleCount > 0
        },
        {
          name: "scroll EventDispatch count >= 300",
          passed: (summary.inputEventTiming.scroll?.count ?? 0) >= 300
        },
        {
          name: "max scroll EventDispatch <= 50 ms",
          passed: (summary.inputEventTiming.scroll?.maxMs ?? 0) <= 50
        },
        {
          name: "scroll EventDispatch inclusive <= 1200 ms",
          passed:
            (summary.inputEventTiming.scroll?.totalInclusiveMs ?? 0) <= 1_200
        },
        {
          name: "Layout inclusive <= 500 ms",
          passed: summary.timing.layoutInclusiveMs <= 500
        },
        {
          name: "UpdateLayoutTree inclusive <= 1000 ms",
          passed: summary.timing.updateLayoutTreeInclusiveMs <= 1_000
        },
        ...forbiddenProfileFunctions.map((functionName) => ({
          name: `${functionName} CPU samples = 0`,
          passed: (profileSamples[functionName] ?? 0) === 0
        }))
      ],
      details: [
        {
          label: "Scroll EventDispatch",
          value: `${summary.inputEventTiming.scroll?.count ?? 0} events; ${summary.inputEventTiming.scroll?.totalInclusiveMs ?? 0} ms inclusive; ${summary.inputEventTiming.scroll?.maxMs ?? 0} ms max`
        },
        {
          label: "Layout / UpdateLayoutTree",
          value: `${summary.timing.layoutInclusiveMs} / ${summary.timing.updateLayoutTreeInclusiveMs} ms inclusive`
        },
        {
          label: "captureScrollAnchor CPU samples",
          value: String(profileSamples.captureScrollAnchor ?? 0)
        }
      ]
    };
  }
};

async function executeVirtualizedScrollLocator(context, _prepared, options) {
  const { pageClient } = context;
  await evaluate(
    pageClient,
    `(() => {
      const timeline = document.querySelector('[data-testid="agent-gui-timeline"]');
      const locator = document.querySelector('[data-testid="agent-message-locator"]');
      if (!(timeline instanceof HTMLElement)) throw new Error('timeline is unavailable');
      if (!(locator instanceof HTMLElement)) throw new Error('message locator is unavailable');
      const state = window.__tuttiPerfVirtualizedScrollLocator = {
        maxHistoricalInteractiveNodes: 0,
        maxMountedMentions: 0,
        maxStaticRichTextNodes: 0,
        selectedIndexes: [],
        stablePolls: 0,
        startVirtualTurnKeys: [...document.querySelectorAll('[data-agent-transcript-virtual-turn]')]
          .map((element) => element.getAttribute('data-agent-transcript-virtual-turn') ?? '')
          .filter(Boolean)
      };
      const transcriptRoot = document.querySelector('[data-agent-transcript-virtualized="true"]');
      if (!(transcriptRoot instanceof HTMLElement)) {
        throw new Error('virtualized transcript is unavailable');
      }
      const recordTranscriptMetrics = () => {
        state.maxHistoricalInteractiveNodes = Math.max(
          state.maxHistoricalInteractiveNodes,
          transcriptRoot.querySelectorAll('[contenteditable="true"], [role="textbox"]').length
        );
        state.maxMountedMentions = Math.max(
          state.maxMountedMentions,
          transcriptRoot.querySelectorAll('[data-agent-file-mention="true"]').length
        );
        state.maxStaticRichTextNodes = Math.max(
          state.maxStaticRichTextNodes,
          transcriptRoot.querySelectorAll('.ProseMirror').length
        );
      };
      const readSelectedIndex = () => [...locator.querySelectorAll('.agent-gui-message-locator__tick')]
        .findIndex((tick) => tick.dataset.selected === 'true');
      const readExpectedSelectedIndex = () => {
        const viewportCenter = timeline.getBoundingClientRect().top + timeline.clientHeight / 2;
        const virtualTurns = [...document.querySelectorAll('[data-agent-transcript-virtual-turn][data-index]')];
        let viewportTurnIndex = -1;
        let viewportTurnDistance = Number.POSITIVE_INFINITY;
        for (const turn of virtualTurns) {
          const rect = turn.getBoundingClientRect();
          const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
          if (distance < viewportTurnDistance) {
            viewportTurnDistance = distance;
            viewportTurnIndex = Number(turn.getAttribute('data-index'));
          }
        }
        const ticks = [...locator.querySelectorAll('.agent-gui-message-locator__tick')];
        let expectedIndex = ticks.length > 0 ? 0 : -1;
        ticks.forEach((tick, index) => {
          const turnGroupIndex = Number(tick.getAttribute('data-agent-message-locator-turn-group-index'));
          if (turnGroupIndex <= viewportTurnIndex) expectedIndex = index;
        });
        return expectedIndex;
      };
      const recordSelectedIndex = () => {
        const index = readSelectedIndex();
        if (index >= 0 && state.selectedIndexes.at(-1) !== index) {
          state.selectedIndexes.push(index);
        }
        return index;
      };
      state.readSelectedIndex = readSelectedIndex;
      state.readExpectedSelectedIndex = readExpectedSelectedIndex;
      state.recordSelectedIndex = recordSelectedIndex;
      state.recordTranscriptMetrics = recordTranscriptMetrics;
      state.observer = new MutationObserver(recordSelectedIndex);
      state.observer.observe(locator, {
        attributeFilter: ['data-selected'],
        attributes: true,
        subtree: true
      });
      state.transcriptObserver = new MutationObserver(recordTranscriptMetrics);
      state.transcriptObserver.observe(transcriptRoot, {
        attributes: true,
        childList: true,
        subtree: true
      });
      recordSelectedIndex();
      recordTranscriptMetrics();
      return true;
    })()`
  );
  await startRendererScenario(pageClient, markers.start);
  const scroll = await evaluate(
    pageClient,
    `new Promise((resolve) => {
      const timeline = document.querySelector('[data-testid="agent-gui-timeline"]');
      const state = window.__tuttiPerfVirtualizedScrollLocator;
      if (!(timeline instanceof HTMLElement) || !state) {
        throw new Error('virtualized scroll fixture is unavailable');
      }
      const startScrollTop = timeline.scrollTop;
      const viewportHeight = timeline.clientHeight;
      const targetScrollTop = 0;
      timeline.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
      const startedAt = performance.now();
      let frame = 0;
      const step = () => {
        frame += 1;
        const elapsedMs = performance.now() - startedAt;
        const progress = Math.min(elapsedMs / ${scrollDurationMs}, 1);
        timeline.scrollTop =
          startScrollTop + (targetScrollTop - startScrollTop) * progress;
        state.recordTranscriptMetrics();
        if (progress < 1) {
          requestAnimationFrame(step);
          return;
        }
        requestAnimationFrame(() => resolve({
          elapsedMs: performance.now() - startedAt,
          startScrollTop,
          endScrollTop: timeline.scrollTop,
          frameCount: frame,
          viewportHeight
        }));
      };
      requestAnimationFrame(step);
    })`,
    true
  );
  await markRenderer(pageClient, markers.scrolled);
  const settled = await waitForEvaluation(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfVirtualizedScrollLocator;
      if (!state) return { ready: false };
      const selectedIndex = state.recordSelectedIndex();
      if (selectedIndex === state.lastPolledIndex) {
        state.stablePolls += 1;
      } else {
        state.stablePolls = 0;
      }
      state.lastPolledIndex = selectedIndex;
      return {
        ready: selectedIndex >= 0 && state.stablePolls >= 5,
        expectedSelectedIndex: state.readExpectedSelectedIndex(),
        selectedIndex,
        selectedIndexes: [...state.selectedIndexes]
      };
    })()`,
    options.timeoutMs,
    "stable virtualized locator selection",
    100
  );
  await markRenderer(pageClient, markers.stable);
  const result = await evaluate(
    pageClient,
    `(() => {
      const state = window.__tuttiPerfVirtualizedScrollLocator;
      const selectedIndexes = [...(state?.selectedIndexes ?? [])];
      state?.observer?.disconnect();
      state?.transcriptObserver?.disconnect();
      let reversedTransitions = 0;
      let returnedTransitions = 0;
      for (let index = 1; index < selectedIndexes.length; index += 1) {
        if (selectedIndexes[index] > selectedIndexes[index - 1]) {
          reversedTransitions += 1;
        }
        if (
          index >= 2 &&
          selectedIndexes[index] === selectedIndexes[index - 2] &&
          selectedIndexes[index] !== selectedIndexes[index - 1]
        ) {
          returnedTransitions += 1;
        }
      }
      return {
        endVirtualTurnKeys: [...document.querySelectorAll('[data-agent-transcript-virtual-turn]')]
          .map((element) => element.getAttribute('data-agent-transcript-virtual-turn') ?? '')
          .filter(Boolean),
        reversedTransitions,
        returnedTransitions,
        selectedIndexes,
        startVirtualTurnKeys: [...(state?.startVirtualTurnKeys ?? [])],
        maxHistoricalInteractiveNodes: state?.maxHistoricalInteractiveNodes ?? 0,
        maxMountedMentions: state?.maxMountedMentions ?? 0,
        maxStaticRichTextNodes: state?.maxStaticRichTextNodes ?? 0
      };
    })()`
  );
  await finishRendererScenario(pageClient, markers.end);
  return {
    ...result,
    ...scroll,
    endScrollTop: scroll.endScrollTop,
    travel: scroll.startScrollTop - scroll.endScrollTop,
    moved: scroll.endScrollTop < scroll.startScrollTop,
    selected: settled.selectedIndex >= 0,
    expectedSelectedIndex: settled.expectedSelectedIndex,
    matchesViewportTurn:
      settled.selectedIndex === settled.expectedSelectedIndex,
    stable: settled.ready
  };
}
