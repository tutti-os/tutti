import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopDaemonEndpoint } from "../transport/paths.ts";
import {
  createTuttidManager,
  isLikelyTuttidProcess,
  managedTuttidStartupError,
  resolveBrowserMcpDaemonEnv,
  resolveComputerMcpDaemonEnv,
  resolveClaudeSDKSidecarDaemonEnv,
  resolveLaunchSpec,
  resolveManagedDaemonProcessEnv,
  resolveManagedPosixShellDaemonEnv,
  resolveManagedUVDaemonEnv,
  resolveMutagenDaemonEnv,
} from "./tuttidManager.ts";

test("resolveManagedUVDaemonEnv points the daemon at packaged archives", async () => {
  const previousEnv = { ...process.env };
  const resourcesPath = await mkdtemp(join(tmpdir(), "tutti-managed-uv-"));
  try {
    delete process.env.TUTTI_BUNDLED_UV_ROOT;
    const runtimeRoot = join(resourcesPath, "bin", "managed-uv");
    await mkdir(runtimeRoot, { recursive: true });
    assert.deepEqual(
      resolveManagedUVDaemonEnv({ isPackaged: true, resourcesPath }),
      { TUTTI_BUNDLED_UV_ROOT: runtimeRoot },
    );
  } finally {
    restoreEnv(previousEnv);
    await rm(resourcesPath, { recursive: true, force: true });
  }
});

test("resolveManagedUVDaemonEnv preserves an explicit override", () => {
  const previousEnv = { ...process.env };
  try {
    process.env.TUTTI_BUNDLED_UV_ROOT = "C:\\custom\\uv";
    assert.deepEqual(
      resolveManagedUVDaemonEnv({
        isPackaged: true,
        resourcesPath: "C:\\resources",
      }),
      {},
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveManagedUVDaemonEnv preserves a shell environment override", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_BUNDLED_UV_ROOT;
    assert.deepEqual(
      resolveManagedUVDaemonEnv(
        { isPackaged: true, resourcesPath: "C:\\resources" },
        { inheritedEnv: { TUTTI_BUNDLED_UV_ROOT: "C:\\shell-uv" } },
      ),
      {},
    );
  } finally {
    restoreEnv(previousEnv);
  }
});

const repoRoot = resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
);

test("rejects startup when the managed tuttid binary cannot be spawned", async () => {
  const previousEnv = { ...process.env };
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "tutti-tuttid-spawn-"));
  const endpoint: DesktopDaemonEndpoint = {
    accessToken: "test-token",
    boundAddr: null,
    listenerInfoPath: join(runtimeDirectory, "listener.json"),
    pidPath: join(runtimeDirectory, "tuttid.pid"),
    requestedAddr: "127.0.0.1:0",
  };
  const tuttidClient = {
    async getHealth() {
      throw new Error("health must not run when spawn fails");
    },
  } as unknown as TuttidClient;

  try {
    process.env.TUTTID_BIN = join(runtimeDirectory, "missing-tuttid");
    const manager = createTuttidManager(endpoint, tuttidClient);

    await assert.rejects(manager.start(), { code: "managed_process_error" });
    assert.equal(endpoint.boundAddr, null);
    await manager.stop();
  } finally {
    restoreEnv(previousEnv);
    await rm(runtimeDirectory, { force: true, recursive: true });
  }
});

test("preserves managed tuttid stderr as a structured startup cause", () => {
  const failure = managedTuttidStartupError(
    new Error("tuttid exited before it published its listener info."),
    "unsupported process cassette schema version 2\n",
  );

  assert.equal(
    failure.message,
    "tuttid exited before it published its listener info.",
  );
  assert.deepEqual(failure.cause, {
    code: "managed_process_stderr",
    message: "unsupported process cassette schema version 2",
  });
});

test("classifies startup errors without daemon diagnostics", () => {
  const original = new Error("listener timeout");
  const failure = managedTuttidStartupError(original, "");
  assert.equal(failure.message, original.message);
  assert.equal(
    (failure as NodeJS.ErrnoException).code,
    "managed_process_error",
  );
});

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
    if (!(await developmentBinaryIsFresh(binaryPath))) {
      t.skip("development tuttid binary is stale relative to tuttid sources");
      return;
    }

    const got = resolveLaunchSpec({
      isPackaged: false,
      resourcesPath: join(tmpdir(), "tutti-resources"),
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
      resourcesPath: join(tmpdir(), "tutti-resources"),
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveComputerMcpDaemonEnv is a no-op outside Windows", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_COMPUTER_MCP_COMMAND;
    delete process.env.TUTTI_COMPUTER_MCP_ENTRY_PATH;
    const got = resolveComputerMcpDaemonEnv();
    if (process.platform !== "win32") {
      assert.deepEqual(got, {});
    }
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
      resourcesPath: join(tmpdir(), "tutti-resources"),
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
      resourcesPath: join(tmpdir(), "tutti-resources"),
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
      resourcesPath: join(tmpdir(), "tutti-resources-missing"),
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
      "chrome-devtools-mcp.js",
    );
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "// stub\n");

    const got = resolveBrowserMcpDaemonEnv({ isPackaged: true, resourcesPath });
    assert.deepEqual(got, {
      TUTTI_BROWSER_MCP_ENTRY_PATH: entry,
    });
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveClaudeSDKSidecarDaemonEnv is a no-op in development", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_CLAUDE_SDK_SIDECAR_COMMAND;
    delete process.env.TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH;
    const got = resolveClaudeSDKSidecarDaemonEnv({
      isPackaged: false,
      resourcesPath: join(tmpdir(), "tutti-resources"),
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveClaudeSDKSidecarDaemonEnv respects an explicit operator override", () => {
  const previousEnv = { ...process.env };
  try {
    process.env.TUTTI_CLAUDE_SDK_SIDECAR_COMMAND = "/custom/sidecar";
    delete process.env.TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH;
    const got = resolveClaudeSDKSidecarDaemonEnv({
      isPackaged: true,
      resourcesPath: join(tmpdir(), "tutti-resources"),
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveClaudeSDKSidecarDaemonEnv points the daemon at a vendored bundle when present", async () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_CLAUDE_SDK_SIDECAR_COMMAND;
    delete process.env.TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH;
    const resourcesPath = await mkdtemp(join(tmpdir(), "tutti-resources-"));
    const entry = join(
      resourcesPath,
      "bin",
      "claude-sdk-sidecar",
      "src",
      "main.ts",
    );
    await mkdir(dirname(entry), { recursive: true });
    await writeFile(entry, "// stub\n");

    const got = resolveClaudeSDKSidecarDaemonEnv({
      isPackaged: true,
      resourcesPath,
    });
    assert.deepEqual(got, {
      TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH: entry,
    });
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveManagedPosixShellDaemonEnv respects an explicit operator override", () => {
  const previousEnv = { ...process.env };
  try {
    process.env.TUTTI_MANAGED_POSIX_SHELL = "C:\\custom\\bash.exe";
    const got = resolveManagedPosixShellDaemonEnv({
      isPackaged: true,
      resourcesPath: join(tmpdir(), "tutti-resources"),
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveManagedPosixShellDaemonEnv points the daemon at the packaged shell", async () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_MANAGED_POSIX_SHELL;
    const resourcesPath = await mkdtemp(join(tmpdir(), "tutti-resources-"));
    const shell = join(
      resourcesPath,
      "bin",
      "managed-posix-shell",
      "usr",
      "bin",
      "bash.exe",
    );
    await mkdir(dirname(shell), { recursive: true });
    await writeFile(shell, "stub\n");
    await writeFile(
      join(resourcesPath, "bin", "managed-posix-shell", "runtime.json"),
      JSON.stringify({
        schemaVersion: "tutti.managed-posix-shell.v1",
        executable: "usr/bin/bash.exe",
      }),
    );

    const got = resolveManagedPosixShellDaemonEnv({
      isPackaged: true,
      resourcesPath,
    });
    assert.deepEqual(got, {
      TUTTI_MANAGED_POSIX_SHELL: shell,
    });
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveMutagenDaemonEnv respects an explicit operator override", () => {
  const previousEnv = { ...process.env };
  try {
    process.env.TUTTI_MUTAGEN_BIN = "C:\\custom\\mutagen.exe";
    const got = resolveMutagenDaemonEnv({
      isPackaged: true,
      resourcesPath: join(tmpdir(), "tutti-resources"),
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveMutagenDaemonEnv respects a shell environment override", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_MUTAGEN_BIN;
    const got = resolveMutagenDaemonEnv(
      {
        isPackaged: true,
        resourcesPath: join(tmpdir(), "tutti-resources"),
      },
      { inheritedEnv: { TUTTI_MUTAGEN_BIN: "C:\\custom\\mutagen.exe" } },
    );
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveMutagenDaemonEnv points the daemon at packaged Mutagen", async () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_MUTAGEN_BIN;
    const resourcesPath = await mkdtemp(join(tmpdir(), "tutti-resources-"));
    const runtimeRoot = join(resourcesPath, "bin", "mutagen");
    const executable = join(runtimeRoot, "mutagen.exe");
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(executable, "stub\n");
    await writeFile(
      join(runtimeRoot, "runtime.json"),
      JSON.stringify({
        schemaVersion: "tutti.mutagen.v1",
        executable: "mutagen.exe",
      }),
    );

    const got = resolveMutagenDaemonEnv({
      isPackaged: true,
      resourcesPath,
    });
    assert.deepEqual(got, { TUTTI_MUTAGEN_BIN: executable });
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveManagedPosixShellDaemonEnv points direct dev at the prepared shell", async () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_MANAGED_POSIX_SHELL;
    const repoRoot = await mkdtemp(join(tmpdir(), "tutti-repo-"));
    const runtimeRoot = join(
      repoRoot,
      "apps",
      "desktop",
      "build",
      "managed-posix-shell",
    );
    const shell = join(runtimeRoot, "usr", "bin", "bash.exe");
    await mkdir(dirname(shell), { recursive: true });
    await writeFile(shell, "stub\n");
    await writeFile(
      join(runtimeRoot, "runtime.json"),
      JSON.stringify({
        schemaVersion: "tutti.managed-posix-shell.v1",
        executable: "usr/bin/bash.exe",
      }),
    );

    const got = resolveManagedPosixShellDaemonEnv(
      {
        isPackaged: false,
        resourcesPath: join(tmpdir(), "electron-resources"),
      },
      { repoRoot },
    );
    assert.deepEqual(got, {
      TUTTI_MANAGED_POSIX_SHELL: shell,
    });
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveManagedPosixShellDaemonEnv rejects an executable outside its runtime root", async () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_MANAGED_POSIX_SHELL;
    const resourcesPath = await mkdtemp(join(tmpdir(), "tutti-resources-"));
    const runtimeRoot = join(resourcesPath, "bin", "managed-posix-shell");
    const outsideShell = join(resourcesPath, "bin", "outside", "bash.exe");
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(dirname(outsideShell), { recursive: true });
    await writeFile(outsideShell, "stub\n");
    await writeFile(
      join(runtimeRoot, "runtime.json"),
      JSON.stringify({
        schemaVersion: "tutti.managed-posix-shell.v1",
        executable: "../outside/bash.exe",
      }),
    );

    const got = resolveManagedPosixShellDaemonEnv({
      isPackaged: true,
      resourcesPath,
    });
    assert.deepEqual(got, {});
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveManagedDaemonProcessEnv seeds the managed runtime cache root", () => {
  const previousEnv = { ...process.env };
  try {
    delete process.env.TUTTI_APP_RUNTIME_ROOT;
    delete process.env.TUTTI_APP_RUNTIME_CACHE_ROOT;
    const endpoint = {
      accessToken: "token",
      boundAddr: null,
      listenerInfoPath: "/tmp/listener.json",
      pidPath: "/tmp/tuttid.pid",
      requestedAddr: "127.0.0.1:0",
    };
    const got = resolveManagedDaemonProcessEnv({
      endpoint,
      logOutput: "file",
      userShellEnv: {},
      logDir: "/tmp/logs",
      parentPID: 123,
      sessionID: "session-1",
      workspaceAppCliPath:
        "C:\\Program Files\\Tutti\\resources\\bin\\tutti.exe",
    });
    assert.equal(
      basename(got.TUTTI_APP_RUNTIME_CACHE_ROOT ?? ""),
      "app-runtimes",
    );
    const browserListenerInfo = got.TUTTI_BROWSER_NODE_LISTENER_INFO ?? "";
    assert.equal(basename(browserListenerInfo), "browser-node-automation.json");
    assert.equal(basename(dirname(browserListenerInfo)), "run");
    assert.equal(
      got.TUTTI_WORKSPACE_APP_CLI_PATH,
      "C:\\Program Files\\Tutti\\resources\\bin\\tutti.exe",
    );
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
      resourcesPath: join(tmpdir(), "tutti-resources"),
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
    binaryName,
  );
  const sourcePath = join(
    tempRepoRoot,
    "services/tuttid/api/events/generated/protocol.gen.go",
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
        resourcesPath: join(tmpdir(), "tutti-resources"),
      },
      { repoRoot: tempRepoRoot },
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
      resourcesPath: join(tmpdir(), "tutti-resources"),
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
    isLikelyTuttidProcess("C:\\Program Files\\Tutti\\tuttid.exe"),
    true,
  );
  assert.equal(
    isLikelyTuttidProcess(join(repoRoot, "apps/desktop/build/tuttid/tuttid")),
    true,
  );
  assert.equal(isLikelyTuttidProcess("node tuttidManager.js"), false);
  assert.equal(isLikelyTuttidProcess("/tmp/not-tuttid"), false);
  assert.equal(isLikelyTuttidProcess(""), false);
});

// Regression coverage for the "lingering codex server processes" report:
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
        requestedAddr: "127.0.0.1:4545",
      },
      logDir: "/tmp/tutti-logs",
      logOutput: "file",
      parentPID: 123,
      sessionID: "session-1",
      userShellEnv: {
        TUTTI_APP_VERSION: "0.0.1",
      },
    });

    assert.equal(got.TUTTI_APP_VERSION, "1.2.3");
    assert.equal(got.TUTTI_ANALYTICS_DEBUG, undefined);
    assert.equal(got.TUTTID_ACCESS_TOKEN, "token");
    assert.equal(got.TUTTID_ADDR, "127.0.0.1:4545");
  } finally {
    restoreEnv(previousEnv);
  }
});

test("resolveManagedDaemonProcessEnv injects one desktop admission identity", () => {
  const got = resolveManagedDaemonProcessEnv({
    desktopUpdateAdmission: {
      architecture: "arm64",
      currentVersion: "1.2.3",
      managed: true,
      packaged: true,
      platform: "macos",
    },
    endpoint: {
      accessToken: "token",
      boundAddr: null,
      listenerInfoPath: "/tmp/tuttid.listener.json",
      pidPath: "/tmp/tuttid.pid",
      requestedAddr: "127.0.0.1:4545",
    },
    logDir: "/tmp/tutti-logs",
    logOutput: "file",
    parentPID: 123,
    sessionID: "session-1",
  });

  assert.equal(got.TUTTI_DESKTOP_UPDATE_ADMISSION_MANAGED, "1");
  assert.equal(got.TUTTI_DESKTOP_UPDATE_ADMISSION_PACKAGED, "1");
  assert.equal(got.TUTTI_DESKTOP_UPDATE_ADMISSION_CURRENT_VERSION, "1.2.3");
  assert.equal(got.TUTTI_DESKTOP_UPDATE_ADMISSION_PLATFORM, "macos");
  assert.equal(got.TUTTI_DESKTOP_UPDATE_ADMISSION_ARCHITECTURE, "arm64");
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

// Mirrors isFreshDevelopmentTuttidBinary in tuttidManager.ts: resolveLaunchSpec
// only prefers the dev binary when it is newer than the generated sources, so
// the positive-path test must apply the same precondition.
async function developmentBinaryIsFresh(binaryPath: string): Promise<boolean> {
  const sentinelPath = join(
    repoRoot,
    "services/tuttid/api/events/generated/protocol.gen.go",
  );

  let binaryModifiedAt: number;
  try {
    binaryModifiedAt = (await stat(binaryPath)).mtimeMs;
  } catch {
    return false;
  }

  try {
    return (await stat(sentinelPath)).mtimeMs <= binaryModifiedAt;
  } catch {
    return true;
  }
}
