import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDesktopAgentConversationDetailMode,
  defaultDesktopToggleFusionDockShortcut,
  desktopFeatureFlagsEqual,
  desktopAgentConversationDetailModes,
  formatDesktopShortcutBinding,
  isDesktopAgentConversationDetailMode,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopFeatureFlags,
  normalizeDesktopShortcutKey,
  normalizeDesktopWorkbenchShortcuts
} from "./core.ts";

test("desktop agent conversation detail mode defaults to coding", () => {
  assert.equal(defaultDesktopAgentConversationDetailMode, "coding");
  assert.deepEqual(desktopAgentConversationDetailModes, ["coding", "general"]);
});

test("desktop agent conversation detail mode normalization preserves known values", () => {
  assert.equal(normalizeDesktopAgentConversationDetailMode("coding"), "coding");
  assert.equal(
    normalizeDesktopAgentConversationDetailMode("general"),
    "general"
  );
  assert.equal(isDesktopAgentConversationDetailMode("coding"), true);
  assert.equal(isDesktopAgentConversationDetailMode("general"), true);
});

test("desktop agent conversation detail mode normalization falls back to coding", () => {
  assert.equal(normalizeDesktopAgentConversationDetailMode(""), "coding");
  assert.equal(normalizeDesktopAgentConversationDetailMode("daily"), "coding");
  assert.equal(
    normalizeDesktopAgentConversationDetailMode(undefined),
    "coding"
  );
  assert.equal(isDesktopAgentConversationDetailMode("daily"), false);
});

test("normalizeDesktopFeatureFlags drops blank keys + coerces booleans", () => {
  assert.deepEqual(
    normalizeDesktopFeatureFlags({
      "lab.enabled": true,
      "": true,
      "  ": false,
      x: 1 as unknown as boolean
    }),
    { "lab.enabled": true, x: true }
  );
});

test("desktopFeatureFlagsEqual is order-insensitive", () => {
  assert.ok(
    desktopFeatureFlagsEqual({ a: true, b: false }, { b: false, a: true })
  );
  assert.ok(!desktopFeatureFlagsEqual({ a: true }, { a: false }));
});

test("normalizeDesktopWorkbenchShortcuts clamps + nulls empty", () => {
  assert.deepEqual(
    normalizeDesktopWorkbenchShortcuts({
      newAgentConversation: "  Meta+K ",
      newSameTypeWindow: "",
      toggleFusionDock: " Meta+Shift+Space "
    }),
    {
      newAgentConversation: "Meta+K",
      newSameTypeWindow: null,
      toggleFusionDock: "Meta+Shift+Space"
    }
  );
});

test("normalizeDesktopWorkbenchShortcuts defaults only a missing Fusion Dock binding", () => {
  assert.deepEqual(normalizeDesktopWorkbenchShortcuts({}), {
    newAgentConversation: null,
    newSameTypeWindow: null,
    toggleFusionDock: defaultDesktopToggleFusionDockShortcut
  });
  assert.equal(
    normalizeDesktopWorkbenchShortcuts({ toggleFusionDock: null })
      .toggleFusionDock,
    null
  );
});

test("formatDesktopShortcutBinding orders modifiers Meta,Ctrl,Alt,Shift", () => {
  assert.equal(
    formatDesktopShortcutBinding({
      key: "k",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true
    }),
    "Meta+Shift+K"
  );
  assert.equal(
    formatDesktopShortcutBinding({
      key: "a",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }),
    null
  );
  assert.equal(normalizeDesktopShortcutKey(" "), "Space");
});
