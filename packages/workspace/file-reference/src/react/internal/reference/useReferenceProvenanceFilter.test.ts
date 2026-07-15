import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { useReferenceProvenanceFilterCatalog } from "./useReferenceProvenanceFilter.ts";

type JsdomModule = {
  JSDOM: new (html: string) => { window: Window & typeof globalThis };
};

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as JsdomModule;

test("provenance hook preserves sequential toggles in one React batch", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  let root: Root | null = null;
  const captured: {
    current: ReturnType<typeof useReferenceProvenanceFilterCatalog> | null;
  } = { current: null };

  function Harness() {
    captured.current = useReferenceProvenanceFilterCatalog({
      enabledDimensions: ["agent"],
      agentOptions: [
        { id: "agent-a", label: "Agent A" },
        { id: "agent-b", label: "Agent B" }
      ],
      memberOptions: []
    });
    return null;
  }

  try {
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const container = dom.window.document.getElementById("root");
    assert.ok(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Harness));
    });
    assert.ok(captured.current);

    await act(async () => {
      captured.current?.controller.toggle("agent", "agent-a");
      captured.current?.controller.toggle("agent", "agent-b");
    });

    assert.deepEqual(captured.current?.snapshot.value.agentTargetIds, []);
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
