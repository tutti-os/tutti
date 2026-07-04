import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDesktopAgentConversationDetailMode,
  desktopAgentConversationDetailModes,
  isDesktopAgentConversationDetailMode,
  normalizeDesktopAgentConversationDetailMode
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
