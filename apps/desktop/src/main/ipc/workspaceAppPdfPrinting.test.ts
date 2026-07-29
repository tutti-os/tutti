import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareWorkspaceAppPrintHtml,
  printMargins
} from "./workspaceAppPdfPrinting.ts";

test("workspace app PDF print HTML injects escaped base and title into head", () => {
  assert.equal(
    prepareWorkspaceAppPrintHtml({
      baseUrl: "https://example.test/a?b=1&c=2",
      html: '<html><head><meta charset="utf-8"></head><body>Hi</body></html>',
      title: "A <Report>"
    }),
    '<html><head><base href="https://example.test/a?b=1&amp;c=2"><title>A &lt;Report&gt;</title><meta charset="utf-8"></head><body>Hi</body></html>'
  );
});

test("workspace app PDF print margins preserve supported units as pixels", () => {
  assert.deepEqual(
    printMargins({
      bottom: "25.4mm",
      left: "1in",
      right: "2.54cm",
      top: "12px"
    }),
    {
      bottom: 96,
      left: 96,
      marginType: "custom",
      right: 96,
      top: 12
    }
  );
});
