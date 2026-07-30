import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopAgentGUIWorkbenchBodyVisibility } from "./desktopAgentGUIWorkbenchVisibility.ts";

test("keeps a visible Mission Control preview rendering", () => {
  assert.equal(
    resolveDesktopAgentGUIWorkbenchBodyVisibility({
      isPresentationVisible: true,
      isVisible: false,
      isVisuallyExposed: false
    }),
    true
  );
});

test("pauses a fully occluded normal Workbench body", () => {
  assert.equal(
    resolveDesktopAgentGUIWorkbenchBodyVisibility({
      isPresentationVisible: false,
      isVisible: true,
      isVisuallyExposed: false
    }),
    false
  );
});
