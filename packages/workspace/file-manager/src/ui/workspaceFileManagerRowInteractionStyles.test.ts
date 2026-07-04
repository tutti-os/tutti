import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Regression coverage for the file manager's row/tile interaction feedback
// (hover, selected, pressed). Before this fix, hover and selected both
// resolved to the same `--transparency-block` token (indistinguishable) and
// there was no press/active feedback at all. See bug 8l4JLW.
function readComponentSource(fileName: string) {
  return readFileSync(new URL(`./${fileName}`, import.meta.url), "utf8");
}

// Extracts the `const <name> = cn(...)` call body so assertions target the
// row/tile's own class list rather than unrelated nested controls (e.g. the
// expand/collapse chevron button) that happen to share token names.
function extractClassNameBuilder(source: string, constName: string): string {
  const startMarker = `const ${constName} = cn(`;
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `expected to find "${startMarker}"`);
  const bodyStart = start + startMarker.length;
  let depth = 1;
  let index = bodyStart;
  while (depth > 0 && index < source.length) {
    const char = source[index];
    if (char === "(") depth++;
    if (char === ")") depth--;
    index++;
  }
  return source.slice(bodyStart, index - 1);
}

const targets: Array<{ fileName: string; constName: string }> = [
  { fileName: "WorkspaceFileManagerPanels.tsx", constName: "rowClassName" },
  { fileName: "WorkspaceFileManagerIconGrid.tsx", constName: "tileClassName" }
];

for (const { fileName, constName } of targets) {
  test(`${fileName} ${constName} has distinct hover, selected, and pressed feedback`, () => {
    const source = extractClassNameBuilder(
      readComponentSource(fileName),
      constName
    );

    // Hover uses a stronger token than the persistent "selected" background
    // so hovering an unselected row is visibly different from selecting it.
    assert.match(source, /hover:bg-transparency-hover/);

    // Selected/persisted state keeps the existing token.
    assert.match(source, /bg-transparency-block/);

    // Press/click feedback must exist (previously entirely absent).
    assert.match(source, /active:bg-\[var\(--transparency-active\)\]/);

    // Hover and selected must not resolve to the same token string.
    assert.doesNotMatch(source, /hover:bg-transparency-block(?!\S)/);
  });
}
