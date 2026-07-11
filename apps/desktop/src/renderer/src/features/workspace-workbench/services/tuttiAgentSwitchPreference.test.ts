import assert from "node:assert/strict";
import test from "node:test";
import {
  hasMigratedTuttiAgentSwitchToDaemon,
  markTuttiAgentSwitchDaemonMigrationComplete,
  readLegacyTuttiAgentSwitchEnabled,
  type TuttiAgentSwitchStorage
} from "./tuttiAgentSwitchPreference.ts";

test("legacy Tutti Agent switch is only a nullable migration input", () => {
  const storage = createStorage();
  assert.equal(readLegacyTuttiAgentSwitchEnabled(storage), null);

  storage.setItem("tutti.workspaceSettings.tuttiAgentSwitchEnabled", "1");
  assert.equal(readLegacyTuttiAgentSwitchEnabled(storage), true);

  storage.setItem("tutti.workspaceSettings.tuttiAgentSwitchEnabled", "0");
  assert.equal(readLegacyTuttiAgentSwitchEnabled(storage), false);
});

test("daemon migration marker is independent of the legacy switch value", () => {
  const storage = createStorage();
  storage.setItem("tutti.workspaceSettings.tuttiAgentSwitchEnabled", "0");
  assert.equal(hasMigratedTuttiAgentSwitchToDaemon(storage), false);

  markTuttiAgentSwitchDaemonMigrationComplete(storage);

  assert.equal(hasMigratedTuttiAgentSwitchToDaemon(storage), true);
  assert.equal(readLegacyTuttiAgentSwitchEnabled(storage), false);
});

function createStorage(): TuttiAgentSwitchStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}
