import assert from "node:assert/strict";
import test from "node:test";
import { resolveBrowserNodeTabCloseIntent } from "./browserNodeTabClose.ts";

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
