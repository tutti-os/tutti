import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveBrowserNodeFinalTabCloseRequest,
  resolveBrowserNodeTabCloseIntent
} from "./browserNodeTabClose.ts";

test("Browser Node prefers a dedicated final-tab surface close request", () => {
  const requests: string[] = [];
  const request = resolveBrowserNodeFinalTabCloseRequest({
    onCloseRequest: () => requests.push("default"),
    onFinalTabCloseRequest: () => requests.push("final-tab")
  });

  request?.();

  assert.deepEqual(requests, ["final-tab"]);
});

test("Browser Node keeps the existing surface close request as a fallback", () => {
  const requests: string[] = [];
  const request = resolveBrowserNodeFinalTabCloseRequest({
    onCloseRequest: () => requests.push("default")
  });

  request?.();

  assert.deepEqual(requests, ["default"]);
});

test("Browser Node closes one of multiple tabs", () => {
  assert.equal(
    resolveBrowserNodeTabCloseIntent({
      hasSurfaceCloseRequest: true,
      tabCount: 2
    }),
    "tab"
  );
});

test("Browser Node delegates its last tab to the surface close request", () => {
  assert.equal(
    resolveBrowserNodeTabCloseIntent({
      hasSurfaceCloseRequest: true,
      tabCount: 1
    }),
    "surface"
  );
});

test("Browser Node keeps its last tab without a surface close request", () => {
  assert.equal(
    resolveBrowserNodeTabCloseIntent({
      hasSurfaceCloseRequest: false,
      tabCount: 1
    }),
    null
  );
});
