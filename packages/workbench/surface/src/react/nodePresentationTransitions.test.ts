import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchNodePresentationTransitionStore } from "./nodePresentationTransitions.ts";

test("keeps a node active until all presentation transitions settle", () => {
  const store = createWorkbenchNodePresentationTransitionStore();

  store.setActive("node-1", "frame", true);
  store.setActive("node-1", "onboarding-entry", true);
  assert.deepEqual([...store.getSnapshot()], ["node-1"]);

  store.setActive("node-1", "frame", false);
  assert.deepEqual([...store.getSnapshot()], ["node-1"]);

  store.setActive("node-1", "onboarding-entry", false);
  assert.deepEqual([...store.getSnapshot()], []);
});
