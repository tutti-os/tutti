import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveFusionDockShortcutAction,
  resolveFusionDockVisibilityPreferenceAction
} from "./fusionDockVisibility.ts";

test("Fusion Dock shortcut expands search, then hides the expanded dock", () => {
  assert.equal(
    resolveFusionDockShortcutAction({
      dockSearchExpanded: false,
      dockVisible: false
    }),
    "expand-and-show"
  );
  assert.equal(
    resolveFusionDockShortcutAction({
      dockSearchExpanded: false,
      dockVisible: true
    }),
    "expand-and-show"
  );
  assert.equal(
    resolveFusionDockShortcutAction({
      dockSearchExpanded: true,
      dockVisible: true
    }),
    "hide"
  );
});

test("Fusion Dock visibility preference transitions preserve focus semantics", () => {
  assert.equal(
    resolveFusionDockVisibilityPreferenceAction({
      dockFocused: false,
      dockVisible: false,
      mode: "always"
    }),
    "show"
  );
  assert.equal(
    resolveFusionDockVisibilityPreferenceAction({
      dockFocused: true,
      dockVisible: true,
      mode: "shortcut-only"
    }),
    "hide"
  );
  assert.equal(
    resolveFusionDockVisibilityPreferenceAction({
      dockFocused: false,
      dockVisible: true,
      mode: "auto-hide"
    }),
    "schedule-auto-hide"
  );
  assert.equal(
    resolveFusionDockVisibilityPreferenceAction({
      dockFocused: true,
      dockVisible: true,
      mode: "auto-hide"
    }),
    null
  );
  assert.equal(
    resolveFusionDockVisibilityPreferenceAction({
      dockFocused: false,
      dockVisible: false,
      mode: "auto-hide"
    }),
    null
  );
});
