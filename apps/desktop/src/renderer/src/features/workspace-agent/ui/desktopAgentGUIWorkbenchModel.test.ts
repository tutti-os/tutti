import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "desktopAgentGUIWorkbenchModel.ts"
  ),
  "utf8"
);

test("Agent GUI context equality observes presentation and minimized state", () => {
  assert.match(source, /previous\.presentationMode === next\.presentationMode/);
  assert.match(
    source,
    /previous\.node\.isMinimized === next\.node\.isMinimized/
  );
});
