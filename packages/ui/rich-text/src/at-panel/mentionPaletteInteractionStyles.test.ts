import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./MentionPalette.tsx", import.meta.url), {
  encoding: "utf8"
});
const stylesheet = readFileSync(
  new URL("./mentionPalette.css", import.meta.url),
  {
    encoding: "utf8"
  }
);

test("mention palette option backgrounds are driven by highlighted state", () => {
  const rowButton = extractPaletteStyle("rowButton");
  const expandButton = extractPaletteStyle("expandButton");

  assert.equal(rowButton, '"rich-text-at-mention-palette__row-button"');
  assert.doesNotMatch(
    stylesheet,
    /\.rich-text-at-mention-palette__row-button:hover/
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__row-button\[data-highlighted\]/
  );

  assert.equal(expandButton, '"rich-text-at-mention-palette__expand-button"');
  assert.doesNotMatch(
    stylesheet,
    /\.rich-text-at-mention-palette__expand-button:hover/
  );
  assert.match(
    stylesheet,
    /\.rich-text-at-mention-palette__expand-button\[data-highlighted\]/
  );
  assert.doesNotMatch(source, /onMouseEnter=/);
  assert.match(source, /onPointerMove=/);
});

test("mention palette always keeps the package root class for css variables", () => {
  assert.match(
    source,
    /DEFAULT_THEME\.classNames\.palette,[\s\S]*theme\.classNames\.palette,[\s\S]*paletteStyles\.palette/
  );
  assert.doesNotMatch(
    source,
    /className=\{cn\(theme\.classNames\.palette,\s*paletteStyles\.palette\)\}/
  );
});

test("mention palette scrolls highlighted options inside its own scroll body", () => {
  assert.match(source, /scrollElementIntoScrollContainerNearest/);
  assert.doesNotMatch(
    source,
    /if \(!scrollHighlightedIntoViewCentered\) \{\s*return;\s*\}/
  );
});

function extractPaletteStyle(name: string): string {
  const match = source.match(new RegExp(`${name}:\\s*(".*?")`, "s"));
  assert.ok(match?.[1], `Expected ${name} style to stay a string literal.`);
  return match[1];
}
