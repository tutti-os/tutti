import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "../..");
const cliDir = join(workspaceRoot, "apps", "cli");
const defaultsPath = join(workspaceRoot, "config", "tutti.defaults.json");
const generatedDefaults = JSON.parse(await readFile(defaultsPath, "utf8"));
const commandName =
  process.platform === "win32" ? "tutti-dev.cmd" : "tutti-dev";
const binaryName = process.platform === "win32" ? "tutti.exe" : "tutti";
const builtCliPath = join(cliDir, "build", "dev", binaryName);
const stateRootDir = resolveDevelopmentStateRoot();
const canonicalShimPath = join(stateRootDir, "bin", commandName);

await buildDevCli();
await writeDevShim(canonicalShimPath, builtCliPath);
const pathShimPath = await installPathShimIfPossible(canonicalShimPath);

log(`built ${builtCliPath}`);
log(`installed ${canonicalShimPath}`);
if (pathShimPath) {
  log(`PATH command ready: ${pathShimPath}`);
} else {
  log(
    `add this once if tutti-dev is not found: export PATH="${join(stateRootDir, "bin")}:$PATH"`
  );
}
log("try: tutti-dev status");

function resolveDevelopmentStateRoot() {
  const override = process.env.TUTTI_STATE_DIR?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), generatedDefaults.state.developmentDirName);
}

async function buildDevCli() {
  await mkdir(dirname(builtCliPath), { recursive: true });
  const goBin = process.env.GO_BIN?.trim() || resolveCommand("go");
  const result = spawnSync(
    goBin,
    ["build", "-buildvcs=false", "-o", builtCliPath, "./cmd/tutti"],
    {
      cwd: cliDir,
      env: {
        ...process.env,
        TUTTI_ENV: "development"
      },
      stdio: "inherit"
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `go build failed with exit code ${result.status ?? "unknown"}`
    );
  }
}

async function installPathShimIfPossible(canonicalPath) {
  if (process.env.TUTTI_DEV_SKIP_PATH_SHIM === "1") {
    return null;
  }

  const pathDirs = pathDirectories();
  if (pathDirs.some((dir) => samePath(dir, dirname(canonicalPath)))) {
    return canonicalPath;
  }

  const existing = await findExistingPathCommand(pathDirs);
  if (existing) {
    if (await isOwnedDevShim(existing)) {
      await writeDevShim(existing, canonicalPath);
      return existing;
    }
    log(
      `found existing tutti-dev outside Tutti control; leaving it unchanged at ${existing}`
    );
    return null;
  }

  const writableDir = await firstWritableUserPathDir(pathDirs);
  if (!writableDir) {
    return null;
  }

  const shimPath = join(writableDir, commandName);
  await writeDevShim(shimPath, canonicalPath);
  return shimPath;
}

async function findExistingPathCommand(pathDirs) {
  for (const dir of pathDirs) {
    const candidate = join(dir, commandName);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function firstWritableUserPathDir(pathDirs) {
  const homeDir = homedir();
  const resolvedPathDirs = new Set(pathDirs.map((dir) => resolve(dir)));
  const candidates = [join(homeDir, ".local", "bin"), join(homeDir, "bin")];
  for (const candidate of candidates) {
    const resolvedDir = resolve(candidate);
    if (
      !resolvedPathDirs.has(resolvedDir) ||
      isWorkspaceLocalPath(resolvedDir)
    ) {
      continue;
    }
    try {
      await mkdir(resolvedDir, { recursive: true });
      await access(resolvedDir, constants.W_OK);
      return resolvedDir;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

function isWorkspaceLocalPath(path) {
  return (
    path === workspaceRoot ||
    path.startsWith(`${workspaceRoot}${sep}`) ||
    path.includes(`${sep}node_modules${sep}`)
  );
}

async function writeDevShim(shimPath, targetPath) {
  await mkdir(dirname(shimPath), { recursive: true });
  if (process.platform === "win32") {
    await writeFile(
      shimPath,
      [
        "@echo off",
        "rem Tutti dev CLI shim",
        `if "%TUTTI_STATE_DIR%"=="" set "TUTTI_STATE_DIR=${stateRootDir}"`,
        `"${targetPath}" %*`,
        ""
      ].join("\r\n"),
      "utf8"
    );
    return;
  }

  await writeFile(
    shimPath,
    [
      "#!/usr/bin/env sh",
      "# Tutti dev CLI shim",
      `if [ -z "\${TUTTI_STATE_DIR:-}" ]; then export TUTTI_STATE_DIR=${shellQuote(stateRootDir)}; fi`,
      `exec ${shellQuote(targetPath)} "$@"`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(shimPath, 0o755);
}

async function isOwnedDevShim(path) {
  try {
    const content = await readFile(path, "utf8");
    return content.includes("Tutti dev CLI shim");
  } catch {
    return false;
  }
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirectories() {
  return (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveCommand(command) {
  if (process.platform === "win32") {
    return `${command}.cmd`;
  }
  return command;
}

function log(message) {
  console.log(`[dev-cli] ${message}`);
}
