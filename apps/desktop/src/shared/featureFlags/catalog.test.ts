import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFusionDockVisibility,
  isFusionModeEnabled,
  isFeatureEnabled,
  labFeatureDefinitions,
  LAB_ENABLED_FLAG,
  LAB_FUSION_DOCK_AUTO_HIDE_FLAG,
  LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG,
  LAB_FUSION_MODE_FLAG,
  resolveFusionDockVisibility,
  withFusionDockVisibility
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

test("Fusion flags default to disabled with an always-visible Dock", () => {
  assert.equal(isFusionModeEnabled({}), false);
  assert.equal(resolveFusionDockVisibility({}), "always");
  assert.equal(isFeatureEnabled({}, LAB_FUSION_DOCK_AUTO_HIDE_FLAG), false);
  assert.equal(isFeatureEnabled({}, LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG), false);
  assert.equal(isFeatureEnabled({}, LAB_FUSION_MODE_FLAG), false);
});

test("Fusion Dock visibility helpers keep visibility flags mutually exclusive", () => {
  assert.equal(isFusionDockVisibility("autoHide"), true);
  assert.equal(isFusionDockVisibility("hidden"), false);
  const shortcutOnly = withFusionDockVisibility(
    { [LAB_FUSION_MODE_FLAG]: true },
    "shortcutOnly"
  );
  assert.equal(isFusionModeEnabled(shortcutOnly), true);
  assert.equal(resolveFusionDockVisibility(shortcutOnly), "shortcutOnly");
  assert.equal(shortcutOnly[LAB_FUSION_DOCK_AUTO_HIDE_FLAG], false);
  assert.equal(shortcutOnly[LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG], true);

  const autoHide = withFusionDockVisibility(shortcutOnly, "autoHide");
  assert.equal(resolveFusionDockVisibility(autoHide), "autoHide");
  assert.equal(autoHide[LAB_FUSION_DOCK_AUTO_HIDE_FLAG], true);
  assert.equal(autoHide[LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG], false);
});

test("shortcut-only wins when legacy flags contain conflicting visibility", () => {
  assert.equal(
    resolveFusionDockVisibility({
      [LAB_FUSION_DOCK_AUTO_HIDE_FLAG]: true,
      [LAB_FUSION_DOCK_SHORTCUT_ONLY_FLAG]: true
    }),
    "shortcutOnly"
  );
});
