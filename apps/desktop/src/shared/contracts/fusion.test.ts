import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopFusionDockLayout,
  isDesktopFusionWindowKind
} from "./fusion.ts";

test("Fusion window kind validation rejects renderer-controlled aliases", () => {
  assert.equal(isDesktopFusionWindowKind("agent"), true);
  assert.equal(isDesktopFusionWindowKind("workspace"), false);
  assert.equal(isDesktopFusionWindowKind(""), false);
});

test("Fusion Dock layout keeps the compact rail aligned with native window chrome", () => {
  assert.equal(desktopFusionDockLayout.collapsedWindowWidthPx, 88);
  assert.equal(
    desktopFusionDockLayout.panelWidthPx,
    desktopFusionDockLayout.collapsedWindowWidthPx -
      desktopFusionDockLayout.windowInsetPx * 2
  );
  assert.equal(
    desktopFusionDockLayout.launcherRailWidthPx,
    desktopFusionDockLayout.panelWidthPx -
      desktopFusionDockLayout.panelBorderWidthPx * 2
  );
});
