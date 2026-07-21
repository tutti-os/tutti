import assert from "node:assert/strict";
import test from "node:test";
import { shouldHideBrowserNodeWebview } from "../react/webviewVisibility.ts";

test("BrowserNode hides webviews for node-level and host-window minimization", () => {
  assert.equal(
    shouldHideBrowserNodeWebview({
      hidden: false,
      isHostOverlayOpen: true,
      isHostMinimizing: false
    }),
    true
  );
  assert.equal(
    shouldHideBrowserNodeWebview({
      hidden: false,
      isHostMinimizing: false
    }),
    false
  );
  assert.equal(
    shouldHideBrowserNodeWebview({
      hidden: true,
      isHostMinimizing: false
    }),
    true
  );
  assert.equal(
    shouldHideBrowserNodeWebview({
      hidden: false,
      isHostMinimizing: true
    }),
    true
  );
});
