import assert from "node:assert/strict";
import test from "node:test";
import { createWorkbenchGenieNodeVisibilityStore } from "./genieNodeVisibility.ts";

test("notifies only the window whose genie visibility changed", () => {
  const store = createWorkbenchGenieNodeVisibilityStore();
  let nodeARenders = 0;
  let nodeBRenders = 0;
  const unsubscribeA = store.subscribe("node-a", () => {
    nodeARenders += 1;
  });
  const unsubscribeB = store.subscribe("node-b", () => {
    nodeBRenders += 1;
  });

  store.setHidden("node-a", true);
  store.setHidden("node-a", true);

  assert.equal(store.getSnapshot("node-a"), true);
  assert.equal(store.getSnapshot("node-b"), false);
  assert.equal(nodeARenders, 1);
  assert.equal(nodeBRenders, 0);

  unsubscribeA();
  unsubscribeB();
  store.dispose();
});

test("publishes an immutable snapshot for transient occlusion", () => {
  const store = createWorkbenchGenieNodeVisibilityStore();
  const initialSnapshot = store.getHiddenNodeIDsSnapshot();
  let allNotifications = 0;
  const unsubscribe = store.subscribeAll(() => {
    allNotifications += 1;
  });

  store.setHidden("node-a", true);
  const hiddenSnapshot = store.getHiddenNodeIDsSnapshot();
  store.setHidden("node-a", true);

  assert.notStrictEqual(hiddenSnapshot, initialSnapshot);
  assert.equal(initialSnapshot.has("node-a"), false);
  assert.equal(hiddenSnapshot.has("node-a"), true);
  assert.equal(allNotifications, 1);

  store.setHidden("node-a", false);

  assert.equal(store.getHiddenNodeIDsSnapshot().has("node-a"), false);
  assert.equal(allNotifications, 2);
  unsubscribe();
  store.dispose();
});

test("lets another node animation reveal its own hidden node", () => {
  const store = createWorkbenchGenieNodeVisibilityStore();
  const tokenA = store.hide("node-a");
  store.hide("node-b");

  assert.equal(store.show("node-a", tokenA), true);
  assert.equal(store.getSnapshot("node-a"), false);
  assert.equal(store.getSnapshot("node-b"), true);
});

test("does not let an old operation reveal the same node", () => {
  const store = createWorkbenchGenieNodeVisibilityStore();
  const oldToken = store.hide("node-a");
  const currentToken = store.hide("node-a");

  assert.equal(store.show("node-a", oldToken), false);
  assert.equal(store.getSnapshot("node-a"), true);
  assert.equal(store.show("node-a", currentToken), true);
  assert.equal(store.getSnapshot("node-a"), false);
});
