import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "WorkspaceAccountMenu.tsx"),
  "utf8"
);

test("workspace account menu is gated by Tutti Agent Switch", () => {
  assert.match(source, /useWorkspaceSettingsService/);
  assert.match(
    source,
    /workspaceSettingsState\.tuttiAgentSwitchEnabled !== true[\s\S]*return null/
  );
});

test("workspace account menu keeps credits inside the dropdown", () => {
  assert.doesNotMatch(source, /data-account-credits-chip/);
  assert.match(source, /CreditsIcon/);
  assert.match(source, /creditsBalance/);
  assert.match(source, /accountMenuState\.links\.usageUrl/);
});
