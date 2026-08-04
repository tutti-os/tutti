import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeTabsStore } from "../core/tabsStore.ts";
import { resolveBrowserNodeInitialUrl } from "./browserNodeInitialUrl.ts";

test("new Browser tabs keep their requested URL before runtime state exists", () => {
  const tabsStore = createBrowserNodeTabsStore();
  const surfaceNodeId = "browser:one";
  tabsStore.ensureSurface(surfaceNodeId, "https://www.google.com/");
  tabsStore.addTab(surfaceNodeId, "https://www.baidu.com/link?target=docs");

  assert.equal(
    resolveBrowserNodeInitialUrl({
      activation: null,
      defaultUrl: "https://www.google.com/",
      externalNodeState: null,
      surfaceNodeId,
      tabsStore
    }),
    "https://www.baidu.com/link?target=docs"
  );
});

test("activation and restored runtime URLs stay ahead of the stored tab URL", () => {
  const tabsStore = createBrowserNodeTabsStore();
  const surfaceNodeId = "browser:one";
  tabsStore.ensureSurface(surfaceNodeId, "https://stored.example/");

  assert.equal(
    resolveBrowserNodeInitialUrl({
      activation: null,
      defaultUrl: "https://default.example/",
      externalNodeState: { url: "https://restored.example/" },
      surfaceNodeId,
      tabsStore
    }),
    "https://restored.example/"
  );
  assert.equal(
    resolveBrowserNodeInitialUrl({
      activation: {
        payload: { url: "https://activated.example/" },
        sequence: 1,
        type: "open-url"
      },
      defaultUrl: "https://default.example/",
      externalNodeState: { url: "https://restored.example/" },
      surfaceNodeId,
      tabsStore
    }),
    "https://activated.example/"
  );
});
