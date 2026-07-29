import assert from "node:assert/strict";
import test from "node:test";
import { isBrowserNodeHomeUrl } from "./browserNodeHome.ts";

test("browser home is limited to an empty browser URL", () => {
  assert.equal(isBrowserNodeHomeUrl(null), true);
  assert.equal(isBrowserNodeHomeUrl(""), true);
  assert.equal(isBrowserNodeHomeUrl(" ABOUT:BLANK "), true);
  assert.equal(isBrowserNodeHomeUrl("https://example.com/"), false);
  assert.equal(isBrowserNodeHomeUrl("file:///workspace/index.html"), false);
});
