import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFeatureEnabled,
  labFeatureDefinitions,
  LAB_ENABLED_FLAG
} from "./catalog.ts";

test("isFeatureEnabled falls back to catalog default when key absent", () => {
  assert.equal(isFeatureEnabled({}, LAB_ENABLED_FLAG), false);
  assert.equal(
    isFeatureEnabled({ [LAB_ENABLED_FLAG]: true }, LAB_ENABLED_FLAG),
    true
  );
});

test("isFeatureEnabled returns false for unknown keys", () => {
  assert.equal(isFeatureEnabled({ "unknown.x": true }, "unknown.x"), true); // present wins
  assert.equal(isFeatureEnabled({}, "unknown.x"), false); // absent + no catalog default
});

test("labFeatureDefinitions excludes the master switch", () => {
  assert.ok(labFeatureDefinitions().every((d) => d.group === "lab"));
});
