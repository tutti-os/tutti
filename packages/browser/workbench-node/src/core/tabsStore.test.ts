import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeTabsStore } from "./tabsStore.ts";

test("browser tabs keep stable child node ids while selecting tabs", () => {
  const store = createBrowserNodeTabsStore();
  const initial = store.ensureSurface("browser:one", "https://one.example");
  const second = store.addTab("browser:one");

  assert.equal(initial.tabs[0]?.nodeId, "browser:one:tab:1");
  assert.equal(second.nodeId, "browser:one:tab:2");
  assert.equal(store.getActiveNodeId("browser:one"), second.nodeId);

  store.selectTab("browser:one", initial.activeTabId);
  assert.equal(store.getActiveNodeId("browser:one"), initial.tabs[0]?.nodeId);
});

test("browser tabs close the active tab and select its nearest neighbor", () => {
  const store = createBrowserNodeTabsStore();
  store.ensureSurface("browser:one", "https://one.example");
  const second = store.addTab("browser:one");
  const third = store.addTab("browser:one");

  assert.deepEqual(store.closeTab("browser:one", third.id), third);
  assert.equal(store.getActiveNodeId("browser:one"), second.nodeId);
  assert.deepEqual(store.closeTab("browser:one", second.id), second);
  assert.equal(store.getActiveNodeId("browser:one"), "browser:one:tab:1");
  assert.equal(store.closeTab("browser:one", "tab-1"), null);
});

test("browser tabs sync the active tab without changing the new-tab home", () => {
  const store = createBrowserNodeTabsStore();
  store.ensureSurface("browser:one", "https://one.example");
  store.syncDefaultUrl("browser:one", "https://two.example");

  assert.equal(
    store.getSurfaceState("browser:one")?.tabs[0]?.defaultUrl,
    "https://two.example"
  );
  assert.equal(store.addTab("browser:one").defaultUrl, "https://one.example");
});

test("browser tabs isolate surfaces and return all tabs on removal", () => {
  const store = createBrowserNodeTabsStore();
  store.ensureSurface("browser:one", "https://one.example");
  store.addTab("browser:one");
  store.ensureSurface("browser:two", "https://two.example");

  assert.equal(store.removeSurface("browser:one").length, 2);
  assert.equal(store.getSurfaceState("browser:one"), null);
  assert.equal(store.getActiveNodeId("browser:one"), "browser:one");
  assert.equal(store.getActiveNodeId("browser:two"), "browser:two:tab:1");
});
