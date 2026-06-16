import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./MentionPalette.tsx", import.meta.url), {
  encoding: "utf8"
});

test("mention palette option backgrounds are driven by highlighted state", () => {
  const rowButton = extractPaletteStyle("rowButton");
  const expandButton = extractPaletteStyle("expandButton");

  assert.doesNotMatch(rowButton, /hover:bg/);
  assert.doesNotMatch(rowButton, /focus:bg/);
  assert.match(
    rowButton,
    /data-\[highlighted\]:bg-\[var\(--transparency-block\)\]/
  );

  assert.doesNotMatch(expandButton, /hover:bg/);
  assert.doesNotMatch(expandButton, /focus-visible:bg/);
  assert.match(
    expandButton,
    /data-\[highlighted\]:bg-\[var\(--transparency-block\)\]/
  );
});

function extractPaletteStyle(name: string): string {
  const match = source.match(new RegExp(`${name}:\\s*(".*?")`, "s"));
  assert.ok(match?.[1], `Expected ${name} style to stay a string literal.`);
  return match[1];
}
