import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mentionPaletteStyles = readFileSync(
  new URL("./mentionPalette.css", import.meta.url),
  "utf8"
);

test("mention palette delegates scroll button transforms to UnderlineTabs", () => {
  const scrollButtonRules = [
    ...mentionPaletteStyles.matchAll(
      /([^{}]*underline-tabs-scroll[^{}]*)\{([^{}]*)\}/g
    )
  ];

  assert.ok(scrollButtonRules.length > 0, "expected scroll button style rules");

  for (const match of scrollButtonRules) {
    const selectors = match[1];
    const declarations = match[2];
    assert.ok(selectors);
    assert.ok(declarations);

    assert.doesNotMatch(
      declarations,
      /(^|\s)transform\s*:/,
      `scroll button transform must be owned by UnderlineTabs: ${selectors.trim()}`
    );
  }
});
