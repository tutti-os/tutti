import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeRuntimeStore } from "./runtimeStore.ts";

test("applies Browser Node runtime state events", () => {
  const store = createBrowserNodeRuntimeStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });

  store.applyEvent({
    canGoBack: true,
    canGoForward: false,
    isLoading: true,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: "Example",
    type: "state",
    url: "https://example.com/"
  });

  assert.equal(notifications, 1);
  assert.deepEqual(store.getNodeState("browser-1"), {
    canGoBack: true,
    canGoForward: false,
    downloads: [],
    error: null,
    findResult: null,
    isAttachedToWindow: false,
    isLoading: true,
    isOccluded: false,
    lifecycle: "active",
    title: "Example",
    url: "https://example.com/",
    zoomFactor: 1
  });

  store.applyEvent({
    code: "navigation-failed",
    diagnosticMessage: "boom",
    nodeId: "browser-1",
    type: "error"
  });
  assert.deepEqual(store.getNodeState("browser-1").error, {
    code: "navigation-failed",
    diagnosticMessage: "boom",
    params: undefined
  });

  store.applyEvent({ nodeId: "browser-1", type: "closed" });
  assert.equal(store.getNodeState("browser-1").lifecycle, "cold");
  unsubscribe();
});

test("applies Browser Node find and zoom state", () => {
  const store = createBrowserNodeRuntimeStore();

  store.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: "Example",
    type: "state",
    url: "https://example.com/",
    zoomFactor: 1.25
  });
  store.applyEvent({
    activeMatchOrdinal: 2,
    finalUpdate: true,
    matches: 7,
    nodeId: "browser-1",
    query: "browser",
    type: "find-result"
  });

  assert.equal(store.getNodeState("browser-1").zoomFactor, 1.25);
  assert.deepEqual(store.getNodeState("browser-1").findResult, {
    activeMatchOrdinal: 2,
    finalUpdate: true,
    matches: 7,
    query: "browser"
  });
});

test("adds and updates Browser Node downloads", () => {
  const store = createBrowserNodeRuntimeStore();
  const initialDownload = {
    canResume: false,
    fileName: "report.pdf",
    filePath: null,
    id: "download-1",
    receivedBytes: 50,
    status: "progressing" as const,
    totalBytes: 100,
    url: "https://example.com/report.pdf"
  };

  store.applyEvent({
    download: initialDownload,
    nodeId: "browser-1",
    type: "download"
  });
  store.applyEvent({
    download: {
      ...initialDownload,
      filePath: "/tmp/report.pdf",
      receivedBytes: 100,
      status: "completed"
    },
    nodeId: "browser-1",
    type: "download"
  });

  assert.deepEqual(store.getNodeState("browser-1").downloads, [
    {
      ...initialDownload,
      filePath: "/tmp/report.pdf",
      receivedBytes: 100,
      status: "completed"
    }
  ]);
});

test("returns stable default runtime state snapshots for missing nodes", () => {
  const store = createBrowserNodeRuntimeStore();

  assert.equal(store.getNodeState("missing"), store.getNodeState("missing"));

  store.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: null,
    type: "state",
    url: "https://example.com/"
  });
  store.applyEvent({ nodeId: "browser-1", type: "closed" });

  assert.equal(
    store.getNodeState("browser-1"),
    store.getNodeState("browser-1")
  );
});

test("keeps Browser Node load errors until a new load starts", () => {
  const store = createBrowserNodeRuntimeStore();

  store.applyEvent({
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    nodeId: "browser-1",
    type: "error"
  });
  store.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: null,
    type: "state",
    url: "http://127.0.0.1:3000/"
  });

  assert.deepEqual(store.getNodeState("browser-1").error, {
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    params: undefined
  });

  store.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: true,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: null,
    type: "state",
    url: "http://127.0.0.1:3000/"
  });

  assert.equal(store.getNodeState("browser-1").error, null);
});

test("keeps Browser Node load errors through Chromium error page loading", () => {
  const store = createBrowserNodeRuntimeStore();

  store.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: null,
    type: "state",
    url: "http://127.0.0.1:3000/"
  });
  store.applyEvent({
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    nodeId: "browser-1",
    type: "error"
  });
  store.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: true,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: null,
    type: "state",
    url: "chrome-error://chromewebdata/"
  });

  assert.deepEqual(store.getNodeState("browser-1").error, {
    code: "navigation-failed",
    diagnosticMessage: "ERR_CONNECTION_REFUSED",
    params: undefined
  });
  assert.equal(store.getNodeState("browser-1").url, "http://127.0.0.1:3000/");

  store.applyEvent({
    canGoBack: false,
    canGoForward: false,
    isLoading: true,
    isOccluded: false,
    lifecycle: "active",
    nodeId: "browser-1",
    title: null,
    type: "state",
    url: "https://example.com/"
  });

  assert.equal(store.getNodeState("browser-1").error, null);
});
