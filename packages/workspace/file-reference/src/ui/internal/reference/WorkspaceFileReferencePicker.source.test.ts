import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./WorkspaceFileReferencePicker.tsx", import.meta.url),
  "utf8"
);

test("workspace file reference picker traps Escape before global shortcut handlers", () => {
  assert.match(
    source,
    /document\.addEventListener\("keydown", handleEscapeKeyDown, \{\s*capture: true\s*\}\);/
  );
  assert.match(source, /onEscapeKeyDown=\{\(event\) => \{/);
  assert.match(source, /event\.preventDefault\(\);/);
  assert.match(source, /event\.stopPropagation\(\);/);
  assert.match(source, /event\.stopImmediatePropagation\(\);/);
  assert.match(source, /onClose\(\);/);
});
