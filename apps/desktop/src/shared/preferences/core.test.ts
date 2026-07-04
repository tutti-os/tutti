import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDesktopAgentConversationDetailMode,
  defaultDesktopAgentDockLayout,
  desktopAgentConversationDetailModes,
  desktopAgentDockLayouts,
  isDesktopAgentConversationDetailMode,
  isDesktopAgentDockLayout,
  normalizeDesktopAgentConversationDetailMode,
  normalizeDesktopAgentDockLayout
} from "./core.ts";

test("desktop agent conversation detail mode defaults to coding", () => {
  assert.equal(defaultDesktopAgentConversationDetailMode, "coding");
  assert.deepEqual(desktopAgentConversationDetailModes, ["coding", "general"]);
});

test("desktop agent dock layout defaults to legacy split", () => {
  assert.equal(defaultDesktopAgentDockLayout, "legacySplit");
  assert.deepEqual(desktopAgentDockLayouts, ["legacySplit", "unified"]);
});

test("desktop agent dock layout normalization preserves known values", () => {
  assert.equal(normalizeDesktopAgentDockLayout("legacySplit"), "legacySplit");
  assert.equal(normalizeDesktopAgentDockLayout("unified"), "unified");
  assert.equal(isDesktopAgentDockLayout("legacySplit"), true);
  assert.equal(isDesktopAgentDockLayout("unified"), true);
});

test("desktop agent dock layout normalization falls back to legacy split", () => {
  assert.equal(normalizeDesktopAgentDockLayout(""), "legacySplit");
  assert.equal(normalizeDesktopAgentDockLayout("stacked"), "legacySplit");
  assert.equal(normalizeDesktopAgentDockLayout(undefined), "legacySplit");
  assert.equal(isDesktopAgentDockLayout("stacked"), false);
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
