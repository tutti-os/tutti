import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launcherSource = await readFile(
  new URL("./start-windows-e2e-dev.ps1", import.meta.url),
  "utf8"
);

test("Windows E2E disables business analytics before launching Electron", () => {
  const disableAnalytics = launcherSource.indexOf(
    '$env:TUTTI_ANALYTICS_DISABLED = "1"'
  );
  const launchElectron = launcherSource.indexOf(
    "$electronProcess = Start-Process"
  );

  assert.notEqual(disableAnalytics, -1);
  assert.notEqual(launchElectron, -1);
  assert.ok(disableAnalytics < launchElectron);
});
