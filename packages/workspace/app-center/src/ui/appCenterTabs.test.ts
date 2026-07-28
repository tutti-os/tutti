import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveActiveAppCenterTab,
  resolveVisibleAppCenterTabs
} from "./appCenterTabs.ts";

test("all app tabs are visible by default", () => {
  assert.deepEqual(resolveVisibleAppCenterTabs(undefined), [
    "recommended",
    "community",
    "my"
  ]);
});

test("hosts can select and order the visible app tabs", () => {
  assert.deepEqual(resolveVisibleAppCenterTabs(["my", "recommended", "my"]), [
    "my",
    "recommended"
  ]);
});

test("an empty visible tab configuration keeps the panel usable", () => {
  assert.deepEqual(resolveVisibleAppCenterTabs([]), ["recommended"]);
});

test("a hidden active tab falls back to the first visible tab", () => {
  assert.equal(
    resolveActiveAppCenterTab("community", ["recommended"]),
    "recommended"
  );
});
