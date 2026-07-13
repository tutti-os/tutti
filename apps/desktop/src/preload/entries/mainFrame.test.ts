import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./main.ts", import.meta.url), "utf8");

test("desktop preload exposes privileged APIs only in the main frame", () => {
  assert.match(
    source,
    /if \(process\.isMainFrame\) \{\s*installDesktopMainFramePreload\(\);\s*\}/
  );
  assert.match(
    source,
    /function installDesktopMainFramePreload[\s\S]*contextBridge\.exposeInMainWorld\("tutti", desktopApi\)/
  );
});
