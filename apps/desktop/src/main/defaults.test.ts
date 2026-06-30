import assert from "node:assert/strict";
import test from "node:test";
import {
  initializeDesktopEnvironment,
  resolveDesktopDefaultsFromEnv,
  resolveDesktopDevelopmentAppName,
  resolveDesktopUserDataPath,
  resolveTuttiEnv
} from "./defaults.ts";

test("resolveDesktopDefaultsFromEnv uses generated development defaults", () => {
  const previousEnv = { ...process.env };
  const homeDir = "/tmp/tutti-desktop-home";

  try {
    process.env.HOME = homeDir;
    process.env.TUTTI_ENV = "development";
    delete process.env.TUTTI_STATE_DIR;
    delete process.env.TUTTI_LOG_DIR;
    delete process.env.TUTTID_RUN_DIR;
    delete process.env.TUTTID_LOG_PATH;
    delete process.env.TUTTI_DESKTOP_LOG_PATH;
    delete process.env.TUTTID_LISTENER_INFO_PATH;
    delete process.env.TUTTID_ADDR;

    const got = resolveDesktopDefaultsFromEnv();

    assert.equal(got.runtime.env, "development");
    assert.equal(got.state.rootDir, `${homeDir}/.tutti-dev`);
    assert.equal(got.state.logsDir, `${homeDir}/.tutti-dev/logs`);
    assert.equal(got.state.runDir, `${homeDir}/.tutti-dev/run`);
    assert.equal(got.state.tuttidDBPath, `${homeDir}/.tutti-dev/tuttid.db`);
    assert.equal(
      got.state.tuttidListenerInfoPath,
      `${homeDir}/.tutti-dev/run/tuttid.listener.json`
    );
    assert.equal(
      got.state.tuttidLogPath,
      `${homeDir}/.tutti-dev/logs/tuttid.log`
    );
    assert.equal(
      got.state.desktopLogPath,
      `${homeDir}/.tutti-dev/logs/tutti-desktop.log`
    );
    assert.equal(
      got.state.tuttidPIDPath,
      `${homeDir}/.tutti-dev/run/tuttid.pid`
    );
    assert.equal(got.transport.tcpAddr, "127.0.0.1:4545");
    assert.equal(got.logging.defaultLevel, "info");
    assert.equal(got.logging.defaultOutput, "file");
    assert.equal(got.logging.maxSizeMB, 50);
    assert.equal(got.logging.maxBackups, 10);
    assert.equal(got.logging.maxAgeDays, 14);
    assert.equal(got.logging.maxTotalMB, 300);
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveDesktopDefaultsFromEnv honors endpoint and log overrides", () => {
  const previousEnv = { ...process.env };

  try {
    process.env.TUTTI_ENV = "production";
    process.env.TUTTI_LOG_DIR = "/tmp/tutti-logs";
    process.env.TUTTID_ADDR = "127.0.0.1:9999";
    process.env.TUTTID_LISTENER_INFO_PATH = "/tmp/tuttid.listener.json";

    const got = resolveDesktopDefaultsFromEnv();

    assert.equal(got.transport.tcpAddr, "127.0.0.1:9999");
    assert.equal(got.state.tuttidListenerInfoPath, "/tmp/tuttid.listener.json");
    assert.equal(got.state.logsDir, "/tmp/tutti-logs");
    assert.equal(got.state.tuttidLogPath, "/tmp/tutti-logs/tuttid.log");
    assert.equal(got.state.desktopLogPath, "/tmp/tutti-logs/tutti-desktop.log");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("initializeDesktopEnvironment sets development and production defaults when unset", () => {
  const previousEnv = { ...process.env };

  try {
    delete process.env.TUTTI_ENV;
    initializeDesktopEnvironment({ isPackaged: false });
    assert.equal(resolveTuttiEnv(), "development");

    delete process.env.TUTTI_ENV;
    initializeDesktopEnvironment({ isPackaged: true });
    assert.equal(resolveTuttiEnv(), "production");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("initializeDesktopEnvironment sets shared app version when unset", () => {
  const previousEnv = { ...process.env };

  try {
    delete process.env.TUTTI_APP_VERSION;

    initializeDesktopEnvironment({
      appVersion: "1.2.3",
      isPackaged: false
    });

    assert.equal(process.env.TUTTI_APP_VERSION, "1.2.3");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("initializeDesktopEnvironment preserves shared app version override", () => {
  const previousEnv = { ...process.env };

  try {
    process.env.TUTTI_APP_VERSION = "9.9.9";

    initializeDesktopEnvironment({
      appVersion: "1.2.3",
      isPackaged: false
    });

    assert.equal(process.env.TUTTI_APP_VERSION, "9.9.9");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveDesktopUserDataPath isolates development Electron storage", () => {
  const previousEnv = { ...process.env };

  try {
    process.env.TUTTI_ENV = "development";

    assert.equal(
      resolveDesktopUserDataPath({
        appDataDir: "/tmp/app-data",
        appName: "Tutti"
      }),
      "/tmp/app-data/Tutti-dev"
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveDesktopUserDataPath keeps production on Electron defaults", () => {
  const previousEnv = { ...process.env };

  try {
    process.env.TUTTI_ENV = "production";

    assert.equal(
      resolveDesktopUserDataPath({
        appDataDir: "/tmp/app-data",
        appName: "Tutti"
      }),
      null
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveDesktopDevelopmentAppName isolates development single-instance identity", () => {
  const previousEnv = { ...process.env };

  try {
    process.env.TUTTI_ENV = "development";
    assert.equal(resolveDesktopDevelopmentAppName("Tutti"), "Tutti Dev");

    process.env.TUTTI_ENV = "production";
    assert.equal(resolveDesktopDevelopmentAppName("Tutti"), null);
  } finally {
    restoreEnv(previousEnv);
  }
});

function restoreEnv(previousEnv: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previousEnv)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
}
