import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  utimes,
  writeFile
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  isLikelyTuttidProcess,
  resolveBrowserMcpDaemonEnv,
  resolveLaunchSpec,
  resolveManagedDaemonProcessEnv
} from "./tuttidManager.ts";

const repoRoot = resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url))
);

test("resolveLaunchSpec prefers the development tuttid binary when present", async (t) => {
  const previousEnv = { ...process.env };
  const binaryName = process.platform === "win32" ? "tuttid.exe" : "tuttid";
  const binaryPath = join(repoRoot, "apps/desktop/build/tuttid", binaryName);

  try {
    delete process.env.TUTTID_BIN;
    if (!(await fileIsExecutable(binaryPath))) {
      t.skip("development tuttid binary is not built");
      return;
    }

    const got = resolveLaunchSpec({
      isPackaged: false,
      resourcesPath: join(tmpdir(), "tutti-resources")
    });

    assert.equal(got.command, binaryPath);
    assert.deepEqual(got.args, []);
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveBrowserMcpDaemonEnv is a no-op in development (daemon uses npx)", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_BROWSER_MCP_COMMAND;
    const got = resolveBrowserMcpDaemonEnv({
      isPackaged: false,
      resourcesPath: join(tmpdir(), "tutti-resources")
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveBrowserMcpDaemonEnv respects an explicit operator override", () => {
  const previousEnv = { ...process.env };
  try {
    process.env.TUTTI_BROWSER_MCP_COMMAND = "/custom/mcp";
    const got = resolveBrowserMcpDaemonEnv({
      isPackaged: true,
      resourcesPath: join(tmpdir(), "tutti-resources")
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveBrowserMcpDaemonEnv respects an explicit args override", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_BROWSER_MCP_COMMAND;
    process.env.TUTTI_BROWSER_MCP_ARGS =
      '["--browserUrl","http://127.0.0.1:9222"]';
    const got = resolveBrowserMcpDaemonEnv({
      isPackaged: true,
      resourcesPath: join(tmpdir(), "tutti-resources")
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveBrowserMcpDaemonEnv falls back to npx when the vendored bundle is absent", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_BROWSER_MCP_COMMAND;
    const got = resolveBrowserMcpDaemonEnv({
      isPackaged: true,
      resourcesPath: join(tmpdir(), "tutti-resources-missing")
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveBrowserMcpDaemonEnv points the daemon at a vendored bundle when present", async () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_BROWSER_MCP_COMMAND;
    const resourcesPath = await mkdtemp(join(tmpdir(), "tutti-resources-"));
    const entry = join(
      resourcesPath,
      "bin",
      "browser-mcp",
      "node_modules",
      "chrome-devtools-mcp",
      "build",
      "src",
      "bin",
      "chrome-devtools-mcp.js"
    );
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "// stub\n");

    const got = resolveBrowserMcpDaemonEnv({ isPackaged: true, resourcesPath });
    assert.deepEqual(got, {
      TUTTI_BROWSER_MCP_ENTRY_PATH: entry
    });
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveLaunchSpec falls back to go run when no development binary exists", async (t) => {
  const previousEnv = { ...process.env };
  const binaryName = process.platform === "win32" ? "tuttid.exe" : "tuttid";
  const binaryPath = join(repoRoot, "apps/desktop/build/tuttid", binaryName);

  try {
    delete process.env.TUTTID_BIN;
    if (await fileIsExecutable(binaryPath)) {
      t.skip("development tuttid binary is built");
      return;
    }

    const got = resolveLaunchSpec({
      isPackaged: false,
      resourcesPath: join(tmpdir(), "tutti-resources")
    });

    assert.equal(got.command, "go");
    assert.deepEqual(got.args, ["run", "."]);
    assert.equal(got.cwd, join(repoRoot, "services/tuttid"));
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveLaunchSpec ignores a stale development binary when tuttid sources changed", async () => {
  const previousEnv = { ...process.env };
  const tempRepoRoot = await mkdtemp(join(tmpdir(), "tuttid-launch-"));
  const binaryName = process.platform === "win32" ? "tuttid.exe" : "tuttid";
  const binaryPath = join(
    tempRepoRoot,
    "apps/desktop/build/tuttid",
    binaryName
  );
  const sourcePath = join(
    tempRepoRoot,
    "services/tuttid/api/events/generated/protocol.gen.go"
  );

  try {
    delete process.env.TUTTID_BIN;
    await mkdir(dirname(binaryPath), { recursive: true });
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(binaryPath, "#!/bin/sh\n");
    await chmod(binaryPath, 0o755);
    await writeFile(sourcePath, "package generated\n");
    await utimes(binaryPath, new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(sourcePath, new Date("2026-01-02"), new Date("2026-01-02"));

    const got = resolveLaunchSpec(
      {
        isPackaged: false,
        resourcesPath: join(tmpdir(), "tutti-resources")
      },
      { repoRoot: tempRepoRoot }
    );

    assert.equal(got.command, "go");
    assert.deepEqual(got.args, ["run", "."]);
    assert.equal(got.cwd, join(tempRepoRoot, "services/tuttid"));
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveLaunchSpec honors TUTTID_BIN override", () => {
  const previousEnv = { ...process.env };

  try {
    process.env.TUTTID_BIN = "/tmp/custom-tuttid";

    const got = resolveLaunchSpec({
      isPackaged: false,
      resourcesPath: join(tmpdir(), "tutti-resources")
    });

    assert.equal(got.command, "/tmp/custom-tuttid");
    assert.deepEqual(got.args, []);
  } finally {
    restoreEnv(previousEnv);
  }
});

test("isLikelyTuttidProcess only matches tuttid executables", () => {
  assert.equal(isLikelyTuttidProcess("/tmp/tuttid"), true);
  assert.equal(
    isLikelyTuttidProcess(join(repoRoot, "apps/desktop/build/tuttid/tuttid")),
    true
  );
  assert.equal(isLikelyTuttidProcess("node tuttidManager.js"), false);
  assert.equal(isLikelyTuttidProcess("/tmp/not-tuttid"), false);
  assert.equal(isLikelyTuttidProcess(""), false);
});

test("resolveManagedDaemonProcessEnv passes the shared desktop app version", () => {
  const previousEnv = { ...process.env };

  try {
    process.env.TUTTI_APP_VERSION = "1.2.3";

    const got = resolveManagedDaemonProcessEnv({
      endpoint: {
        accessToken: "token",
        boundAddr: null,
        listenerInfoPath: "/tmp/tuttid.listener.json",
        pidPath: "/tmp/tuttid.pid",
        requestedAddr: "127.0.0.1:4545"
      },
      logDir: "/tmp/tutti-logs",
      logOutput: "file",
      parentPID: 123,
      sessionID: "session-1",
      userShellEnv: {
        TUTTI_APP_VERSION: "0.0.1"
      }
    });

    assert.equal(got.TUTTI_APP_VERSION, "1.2.3");
    assert.equal(got.TUTTI_ANALYTICS_DEBUG, undefined);
    assert.equal(got.TUTTID_ACCESS_TOKEN, "token");
    assert.equal(got.TUTTID_ADDR, "127.0.0.1:4545");
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

async function fileIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
