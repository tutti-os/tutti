import assert from "node:assert/strict";
import test from "node:test";
import {
  clearTuttiAgentSwitchDaemonMigration,
  hasMigratedTuttiAgentSwitchToDaemon,
  markTuttiAgentSwitchDaemonMigrationComplete,
  readLegacyTuttiAgentSwitchEnabled,
  type TuttiAgentSwitchStorage
} from "./tuttiAgentSwitchPreference.ts";

test("legacy Tutti Agent switch is only a nullable migration input", () => {
  const storage = createStorage();
  assert.deepEqual(readLegacyTuttiAgentSwitchEnabled(storage), {
    status: "missing"
  });

  storage.setItem("tutti.workspaceSettings.tuttiAgentSwitchEnabled", "1");
  assert.deepEqual(readLegacyTuttiAgentSwitchEnabled(storage), {
    enabled: true,
    status: "value"
  });

  storage.setItem("tutti.workspaceSettings.tuttiAgentSwitchEnabled", "0");
  assert.deepEqual(readLegacyTuttiAgentSwitchEnabled(storage), {
    enabled: false,
    status: "value"
  });
});

test("daemon migration marker is independent of the legacy switch value", () => {
  const storage = createStorage();
  storage.setItem("tutti.workspaceSettings.tuttiAgentSwitchEnabled", "0");
  assert.equal(hasMigratedTuttiAgentSwitchToDaemon(storage), false);

  markTuttiAgentSwitchDaemonMigrationComplete(storage);

  assert.equal(hasMigratedTuttiAgentSwitchToDaemon(storage), true);
  assert.deepEqual(readLegacyTuttiAgentSwitchEnabled(storage), {
    enabled: false,
    status: "value"
  });

  clearTuttiAgentSwitchDaemonMigration(storage);
  assert.equal(hasMigratedTuttiAgentSwitchToDaemon(storage), false);
});

test("legacy Tutti Agent switch distinguishes storage errors from missing values", () => {
  const storage = createStorage();
  storage.getItem = () => {
    throw new Error("storage unavailable");
  };

  assert.deepEqual(readLegacyTuttiAgentSwitchEnabled(storage), {
    status: "error"
  });
});

test("daemon migration marker reports persistence failures", () => {
  const storage = createStorage();
  storage.setItem = () => {
    throw new Error("storage unavailable");
  };

  assert.equal(markTuttiAgentSwitchDaemonMigrationComplete(storage), false);
});

function createStorage(): TuttiAgentSwitchStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => values.set(key, value)
  };
}
