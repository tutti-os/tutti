import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeCssHasPerformance,
  isCssHasPerformancePath
} from "./css-has-performance-policy.mjs";

test("rejects :has() on document and large dynamic component subjects", () => {
  const source = [
    "body:has(.modal-open) { overflow: hidden; }",
    ".workbench-window[data-mode='custom']:has(.editor) { display: grid; }",
    ".shell .agent-gui-transcript-row:not(:has(.tool-row)) { margin: 0; }"
  ].join("\n");

  const diagnostics = analyzeCssHasPerformance({
    path: "packages/example/styles.css",
    source
  });

  assert.deepEqual(
    diagnostics.map(({ line, subject }) => ({ line, subject })),
    [
      { line: 1, subject: "body" },
      { line: 2, subject: ".workbench-window" },
      { line: 3, subject: ".agent-gui-transcript-row" }
    ]
  );
});

test("allows bounded local subjects and descendant controls inside large surfaces", () => {
  const source = [
    ".workbench-window .local-button:has(svg) { color: red; }",
    ".agent-gui-node__conversation-item:has([data-state='open']) {}",
    ".dialog:not(:has(.actions)) .controls {}"
  ].join("\n");

  assert.deepEqual(
    analyzeCssHasPerformance({
      path: "packages/example/styles.css",
      source
    }),
    []
  );
});

test("handles selector lists, nested at-rules, comments, and strings", () => {
  const source = [
    "@media (min-width: 1px) {",
    "  /* .workbench-window:has(.ignored) {} */",
    "  .safe,",
    "  .agent-gui-node__timeline:has(.streaming) {",
    '    content: ".workbench-window:has(.ignored)";',
    "  }",
    "}"
  ].join("\n");

  const diagnostics = analyzeCssHasPerformance({
    path: "packages/example/styles.css",
    source
  });

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.line, 4);
  assert.equal(diagnostics[0]?.subject, ".agent-gui-node__timeline");
  assert.match(diagnostics[0]?.selector ?? "", /\.safe,/u);
});

test("comments cannot hide a forbidden :has() subject", () => {
  const diagnostics = analyzeCssHasPerformance({
    path: "packages/example/styles.css",
    source: ".workbench-window/* comment */:has(.editor) {}"
  });

  assert.equal(diagnostics[0]?.subject, ".workbench-window");
});

test("does not confuse similarly prefixed local classes with forbidden roots", () => {
  const source = [
    ".workbench-window__title:has(.status) {}",
    ".agent-gui-node__timeline-label:has(svg) {}",
    ".desktop-dock-popup:has(.item) {}"
  ].join("\n");

  assert.deepEqual(
    analyzeCssHasPerformance({
      path: "packages/example/styles.css",
      source
    }),
    []
  );
});

test("CSS performance path scope covers production stylesheets only", () => {
  assert.equal(
    isCssHasPerformancePath(
      "packages/agent/gui/app/renderer/agentactivity.css"
    ),
    true
  );
  assert.equal(
    isCssHasPerformancePath("apps/desktop/src/renderer/styles.css"),
    true
  );
  assert.equal(
    isCssHasPerformancePath("packages/example/dist/styles.css"),
    false
  );
  assert.equal(isCssHasPerformancePath("tools/fixtures/negative.css"), false);
  assert.equal(
    isCssHasPerformancePath("packages/example/styles.test.css"),
    false
  );
});
