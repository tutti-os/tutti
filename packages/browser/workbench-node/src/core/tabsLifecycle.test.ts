import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeFeature } from "./feature.ts";
import { retainBrowserNodeTabSurface } from "./tabsLifecycle.ts";
import type { BrowserNodeHostApi } from "./types.ts";

test("tab surface guests close only after the final surface consumer releases", async () => {
  const closedNodeIds: string[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      close: async ({ nodeId }) => {
        closedNodeIds.push(nodeId);
      }
    })
  });
  feature.tabsStore.ensureSurface("browser:one", "https://one.example");
  feature.tabsStore.addTab("browser:one");
  const releaseHeader = retainBrowserNodeTabSurface(feature, "browser:one");
  const releaseBody = retainBrowserNodeTabSurface(feature, "browser:one");

  releaseHeader();
  await Promise.resolve();
  assert.deepEqual(closedNodeIds, []);

  releaseBody();
  await Promise.resolve();
  assert.deepEqual(closedNodeIds, ["browser:one:tab:1", "browser:one:tab:2"]);
  assert.equal(feature.tabsStore.getSurfaceState("browser:one"), null);
});

test("tab surface release tolerates an immediate strict-mode retain", async () => {
  const closedNodeIds: string[] = [];
  const feature = createBrowserNodeFeature({
    hostApi: createBrowserNodeHostApi({
      close: async ({ nodeId }) => {
        closedNodeIds.push(nodeId);
      }
    })
  });
  feature.tabsStore.ensureSurface("browser:one", "https://one.example");
  const firstRelease = retainBrowserNodeTabSurface(feature, "browser:one");

  firstRelease();
  const secondRelease = retainBrowserNodeTabSurface(feature, "browser:one");
  await Promise.resolve();
  assert.deepEqual(closedNodeIds, []);

  secondRelease();
  await Promise.resolve();
  assert.deepEqual(closedNodeIds, ["browser:one:tab:1"]);
});

function createBrowserNodeHostApi(
  overrides: Partial<BrowserNodeHostApi> = {}
): BrowserNodeHostApi {
  return {
    activate: overrides.activate ?? (() => Promise.resolve()),
    close: overrides.close ?? (() => Promise.resolve()),
    goBack: overrides.goBack ?? (() => Promise.resolve()),
    goForward: overrides.goForward ?? (() => Promise.resolve()),
    navigate: overrides.navigate ?? (() => Promise.resolve()),
    onEvent: overrides.onEvent ?? (() => () => undefined),
    prepareSession: overrides.prepareSession ?? (() => Promise.resolve()),
    registerGuest: overrides.registerGuest ?? (() => Promise.resolve()),
    reload: overrides.reload ?? (() => Promise.resolve()),
    unregisterGuest: overrides.unregisterGuest ?? (() => Promise.resolve())
  };
}
