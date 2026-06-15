import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PutDesktopPreferencesRequest } from "@tutti-os/client-tuttid-ts";
import { createDesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import type { DesktopLogger } from "./logging.ts";

test("createDesktopHostPreferencesState initializes missing preferences with dark theme and default icons", async () => {
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: false,
          preferences: {
            agentComposerDefaultsByProvider: {},
            defaultAgentProvider: "codex",

            dockIconStyle: "flat",
            dockPlacement: "bottom",
            locale: "en",
            sleepPreventionMode: "never",
            themeSource: "system",
            updateChannel: "rc",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences(request) {
        putRequests.push(request);
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.deepEqual(putRequests, [
    {
      preferences: {
        agentComposerDefaultsByProvider: {},
        defaultAgentProvider: "codex",

        dockIconStyle: "default",
        dockPlacement: "bottom",
        locale: "zh-CN",
        sleepPreventionMode: "never",
        themeSource: "dark",
        updateChannel: "rc",
        updatePolicy: "prompt"
      }
    }
  ]);
  assert.equal(state.getDockPlacement(), "bottom");
  assert.equal(state.getLocale(), "zh-CN");
  assert.equal(state.getDefaultAgentProvider(), "codex");
  assert.equal(state.getSleepPreventionMode(), "never");
  assert.equal(state.getDockIconStyle(), "default");
  assert.equal(state.getThemeSource(), "dark");
});

test("createDesktopHostPreferencesState keeps initialized theme preferences", async () => {
  let putCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            locale: "en",
            sleepPreventionMode: "never",
            themeSource: "system",
            updateChannel: "rc",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences() {
        putCalls += 1;
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });

  assert.equal(putCalls, 0);
  assert.equal(state.getDockPlacement(), "bottom");
  assert.equal(state.getLocale(), "en");
  assert.equal(state.getDefaultAgentProvider(), "codex");
  assert.equal(state.getSleepPreventionMode(), "never");
  assert.equal(state.getThemeSource(), "system");
});

test("createDesktopHostPreferencesState migrates the old stable default update channel once", async () => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-update-channel-migration-")
  );
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            locale: "zh-CN",
            sleepPreventionMode: "never",
            themeSource: "dark",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences(request) {
        putRequests.push(request);
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.equal(state.getUpdateChannel(), "rc");
  assert.equal(putRequests.length, 1);
  assert.equal(putRequests[0]?.preferences.updateChannel, "rc");
  assert.match(
    await readFile(
      join(
        migrationStateRootDir,
        "migrations",
        "desktop-update-channel-default-rc-v1"
      ),
      "utf8"
    ),
    /^\d{4}-\d{2}-\d{2}T/
  );
});

test("createDesktopHostPreferencesState preserves stable after the update channel migration ran", async () => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-update-channel-migration-")
  );
  await mkdir(join(migrationStateRootDir, "migrations"), { recursive: true });
  await writeFile(
    join(
      migrationStateRootDir,
      "migrations",
      "desktop-update-channel-default-rc-v1"
    ),
    "applied",
    "utf8"
  );
  let putCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            locale: "zh-CN",
            sleepPreventionMode: "never",
            themeSource: "dark",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences() {
        putCalls += 1;
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });

  assert.equal(putCalls, 0);
  assert.equal(state.getUpdateChannel(), "stable");
});

test("createDesktopHostPreferencesState notifies subscribers after sync changes", async () => {
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            locale: "en",
            sleepPreventionMode: "never",
            themeSource: "system",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences() {
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });
  let notifications = 0;
  const unsubscribe = state.subscribe(() => {
    notifications += 1;
  });

  state.sync({ locale: "zh-CN" });
  state.sync({ locale: "zh-CN" });
  state.sync({ defaultAgentProvider: "claude-code" });
  state.sync({ defaultAgentProvider: "claude-code" });
  state.sync({ dockPlacement: "left" });
  state.sync({ dockPlacement: "left" });
  state.sync({ sleepPreventionMode: "whileAgentRunning" });
  state.sync({ sleepPreventionMode: "whileAgentRunning" });
  unsubscribe();
  state.sync({ locale: "en" });

  assert.equal(notifications, 4);
});

function createLogger(): DesktopLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async close() {}
  };
}
