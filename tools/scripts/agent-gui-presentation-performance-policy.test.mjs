import assert from "node:assert/strict";
import test from "node:test";

import {
  agentGuiPresentationStylesheet,
  analyzeAgentGuiPresentationCss,
  countInlineCompositorHints,
  countPresentationSchedulers,
  hasPresentationWorkReason,
  isInlineCompositorHintLine,
  isPresentationSchedulerLine,
  validatePresentationHintReasons
} from "./agent-gui-presentation-performance-policy.mjs";

test("finds persistent compositor hints and infinite animations outside keyframes", () => {
  const source = `
    .viewer {
      transform: translate3d(0, 0, 0);
      backface-visibility: hidden;
      will-change: opacity, transform;
      animation: pulse 1s linear infinite;
    }
    @keyframes pulse {
      from { transform: translate3d(0, 1px, 0); }
      to { transform: translate3d(0, 0, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .viewer { will-change: auto; }
    }
  `;
  const result = analyzeAgentGuiPresentationCss(
    "packages/agent/gui/view.css",
    source
  );

  assert.deepEqual(
    result.hints.map(({ property }) => property),
    ["transform", "backface-visibility", "will-change", "animation"]
  );
  assert.equal(result.violations.length, 0);
});

test("rejects transition all but permits explicit transition properties", () => {
  const result = analyzeAgentGuiPresentationCss(
    "packages/agent/gui/view.css",
    `
      .bad { transition: all 180ms ease; }
      .also-bad { transition-property: opacity, all; }
      .good { transition: opacity 180ms ease, transform 180ms ease; }
    `
  );

  assert.deepEqual(
    result.violations.map(({ rule }) => rule),
    ["no-transition-all", "no-transition-all"]
  );
});

test("requires the hidden and inactive AgentGUI pruning declarations", () => {
  const missing = analyzeAgentGuiPresentationCss(
    agentGuiPresentationStylesheet,
    ".unrelated { color: red; }"
  );
  assert.equal(missing.missingRequiredDeclarations.length, 4);

  const complete = analyzeAgentGuiPresentationCss(
    agentGuiPresentationStylesheet,
    `
      .agent-gui-node__layout[data-agent-gui-visible="false"]
        :where(*, *::before, *::after) {
        animation-play-state: paused !important;
      }
      .agent-gui-node__layout[data-agent-gui-visible="false"] {
        content-visibility: hidden;
      }
      .agent-gui-node__layout[data-agent-gui-active="false"]
        .agent-gui-node__composer-prompt-tip-track,
      .agent-gui-node__layout[data-agent-gui-active="false"]
        .agent-gui-node__composer-prompt-tip-item {
        animation: none;
        will-change: auto;
      }
    `
  );
  assert.deepEqual(complete.missingRequiredDeclarations, []);
});

test("validates exact presentation-hint reasons and rejects stale reasons", () => {
  const { hints } = analyzeAgentGuiPresentationCss(
    "packages/agent/gui/view.css",
    ".viewer { will-change: transform; }"
  );
  const fingerprint = hints[0]?.fingerprint;
  assert.ok(fingerprint);

  assert.deepEqual(validatePresentationHintReasons(hints, {}), {
    missing: [fingerprint],
    stale: []
  });
  assert.deepEqual(
    validatePresentationHintReasons(hints, {
      [fingerprint]: "Mounted only while the zoom viewer is open"
    }),
    { missing: [], stale: [] }
  );
  assert.deepEqual(
    validatePresentationHintReasons(hints, {
      stale: "Removed selector"
    }),
    { missing: [fingerprint], stale: ["stale"] }
  );
});

test("counts raw presentation schedulers without counting comments or strings", () => {
  const source = `
    // requestAnimationFrame(ignored)
    const label = "new ResizeObserver(ignored)";
    requestAnimationFrame(render);
    requestIdleCallback(load);
    const observer = new ResizeObserver(measure);
  `;
  assert.equal(countPresentationSchedulers(source), 3);
  assert.equal(
    isPresentationSchedulerLine("window.requestAnimationFrame(run)"),
    true
  );
  assert.equal(isPresentationSchedulerLine("cancelAnimationFrame(id)"), false);
});

test("counts inline compositor hints including template transform values", () => {
  const source = `
    // willChange: "transform"
    const style = {
      willChange: "opacity, transform",
      transform: \`translate3d(\${x}px, 0, 0)\`
    };
  `;
  assert.equal(countInlineCompositorHints(source), 2);
  assert.equal(isInlineCompositorHintLine('willChange: "transform"'), true);
  assert.equal(
    isInlineCompositorHintLine("transform: `translate3d(${x}px, 0, 0)`"),
    true
  );
});

test("requires a presentation-work reason on the same or previous line", () => {
  const contentLines = [
    "// presentation-work: one frame while the visible viewer is dragging",
    "requestAnimationFrame(commit);",
    "requestAnimationFrame(unexplained);"
  ];
  assert.equal(hasPresentationWorkReason(contentLines, 2), true);
  assert.equal(hasPresentationWorkReason(contentLines, 3), false);
});
