import assert from "node:assert/strict";
import test from "node:test";
import { makeAtPanelKeyDown } from "./useAtPanelKeyboard.ts";

test("makeAtPanelKeyDown maps navigation and commit keys", () => {
  const calls: string[] = [];
  const onKeyDown = makeAtPanelKeyDown({
    close: () => calls.push("close"),
    commitSelection: () => calls.push("commit"),
    cycleFilter: (delta) => calls.push(`cycle:${delta}`),
    moveSelection: (delta) => calls.push(`move:${delta}`)
  });

  assert.equal(onKeyDown(keyEvent("ArrowDown")), true);
  assert.equal(onKeyDown(keyEvent("ArrowUp")), true);
  assert.equal(onKeyDown(keyEvent("Enter")), true);
  assert.equal(onKeyDown(keyEvent("Tab")), true);
  assert.equal(onKeyDown(keyEvent("Tab", { shiftKey: true })), true);
  assert.equal(onKeyDown(keyEvent("Escape")), true);
  assert.equal(onKeyDown(keyEvent("a")), false);

  assert.deepEqual(calls, [
    "move:1",
    "move:-1",
    "commit",
    "cycle:1",
    "cycle:-1",
    "close"
  ]);
});

function keyEvent(
  key: string,
  options: { shiftKey?: boolean } = {}
): { key: string; shiftKey?: boolean; preventDefault: () => void } {
  return {
    key,
    shiftKey: options.shiftKey,
    preventDefault: () => undefined
  };
}
