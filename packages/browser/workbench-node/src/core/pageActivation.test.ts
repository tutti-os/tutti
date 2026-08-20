import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeFeature } from "./feature.ts";
import {
  activateBrowserNodePageByUrl,
  findBrowserNodePageByUrl
} from "./pageActivation.ts";
import type { BrowserNodeHostApi } from "./types.ts";

const surfaceNodeId = "browser-surface";

test("prefers a live URL match while retaining redirected launch URLs as aliases", () => {
  const feature = createFeature();
  const first = feature.tabsStore.ensureSurface(
    surfaceNodeId,
    "https://first.test/launch"
  ).tabs[0];
  assert.ok(first);
  const second = feature.tabsStore.addTab(
    surfaceNodeId,
    "https://first.test/current?view=live"
  );

  feature.runtimeStore.applyEvent(
    createStateEvent(first.nodeId, "https://first.test/current?view=live")
  );
  feature.runtimeStore.applyEvent(
    createStateEvent(second.nodeId, "https://second.test/current")
  );

  assert.equal(
    findBrowserNodePageByUrl(
      feature,
      surfaceNodeId,
      "https://first.test/current?view=live"
    )?.nodeId,
    first.nodeId
  );
  assert.equal(
    findBrowserNodePageByUrl(
      feature,
      surfaceNodeId,
      "https://first.test/launch"
    )?.nodeId,
    first.nodeId
  );
});

test("finds a newly created page by its desired URL before runtime state arrives", () => {
  const feature = createFeature();
  feature.tabsStore.ensureSurface(surfaceNodeId, "about:blank");
  const pending = feature.tabsStore.addTab(
    surfaceNodeId,
    "https://pending.test/path"
  );

  assert.equal(
    findBrowserNodePageByUrl(
      feature,
      surfaceNodeId,
      "https://pending.test/path"
    )?.nodeId,
    pending.nodeId
  );
});

test("activates a matching page without creating another tab", () => {
  const feature = createFeature();
  const first = feature.tabsStore.ensureSurface(
    surfaceNodeId,
    "https://first.test"
  ).tabs[0];
  assert.ok(first);
  const second = feature.tabsStore.addTab(surfaceNodeId, "https://second.test");
  feature.tabsStore.selectTab(surfaceNodeId, second.id);

  const activated = activateBrowserNodePageByUrl(
    feature,
    surfaceNodeId,
    "https://first.test/"
  );

  assert.equal(activated?.nodeId, first.nodeId);
  assert.equal(
    feature.tabsStore.getSurfaceState(surfaceNodeId)?.activeTabId,
    first.id
  );
  assert.equal(
    feature.tabsStore.getSurfaceState(surfaceNodeId)?.tabs.length,
    2
  );
});

test("does not treat an empty home tab as a reusable URL page", () => {
  const feature = createFeature();
  feature.tabsStore.ensureSurface(surfaceNodeId, "about:blank");

  assert.equal(
    findBrowserNodePageByUrl(feature, surfaceNodeId, "about:blank"),
    null
  );
});

function createFeature() {
  return createBrowserNodeFeature({ hostApi: createBrowserApi() });
}

function createBrowserApi(): BrowserNodeHostApi {
  return {
    activate: async () => undefined,
    close: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    navigate: async () => undefined,
    onEvent: () => () => undefined,
    prepareSession: async () => undefined,
    registerGuest: async () => undefined,
    reload: async () => undefined,
    unregisterGuest: async () => undefined
  };
}

function createStateEvent(nodeId: string, url: string) {
  return {
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active" as const,
    nodeId,
    title: null,
    type: "state" as const,
    url
  };
}
