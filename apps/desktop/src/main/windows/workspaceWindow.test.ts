import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "workspaceWindow.ts"),
  "utf8"
);

test("workspace window positions macOS traffic lights with 16px left padding", () => {
  assert.match(source, /const workspaceWindowMacTrafficLightInsetPx = 16;/);
  assert.match(source, /const workspaceWindowMacTrafficLightSizePx = 12;/);
  assert.match(
    source,
    /workspaceWindowHeaderHeightPx - workspaceWindowMacTrafficLightSizePx/
  );
  assert.match(source, /x: workspaceWindowMacTrafficLightInsetPx/);
  assert.match(source, /y: workspaceWindowMacTrafficLightPositionY/);
});
