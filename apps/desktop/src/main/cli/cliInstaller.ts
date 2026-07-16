import { spawnSync } from "node:child_process";
import { constants, existsSync, mkdirSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCachedUserShellEnv } from "../daemon/userShellEnv.ts";
import { resolveDesktopDefaultsFromEnv } from "../defaults.ts";

export interface DesktopCliShimState {
  installed: boolean;
  pathShimPath: string | null;
  shimPath: string;
}

export interface EnsureDesktopCliShimOptions {
  goBin?: string;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  pathEnv?: string;
  repoRoot?: string;
  resourcesPath?: string;
  stateRootDir?: string;
}

export async function ensureDesktopCliShim(
  options: EnsureDesktopCliShimOptions = {}
): Promise<DesktopCliShimState> {
  const isPackaged = options.isPackaged ?? false;
  const platform = options.platform ?? process.platform;
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const stateRootDir =
    options.stateRootDir ?? resolveDesktopDefaultsFromEnv().state.rootDir;
  const binaryName = platform === "win32" ? "tutti.exe" : "tutti";
  const packagedCliPath = join(resourcesPath, "bin", binaryName);
  const shimPath = resolveUserShimPath(stateRootDir, platform, {
    development: !isPackaged
  });
  let cliTargetPath = packagedCliPath;

  if (!isPackaged) {
    const repoRoot = options.repoRoot ?? resolveRepoRoot();
    const builtCliPath = join(
      repoRoot,
      "apps",
      "cli",
      "build",
      "dev",
      binaryName
    );
    ensureDevCliBinary({
      goBin: options.goBin,
      platform,
      repoRoot,
      targetPath: builtCliPath
    });
    cliTargetPath = builtCliPath;
  }

  await mkdir(join(stateRootDir, "bin"), { recursive: true });
  if (platform === "win32") {
    await writeWindowsShim(shimPath, cliTargetPath, stateRootDir, {
      development: !isPackaged
    });
  } else {
    await writeUnixShim(shimPath, cliTargetPath, stateRootDir, {
      development: !isPackaged
    });
  }

  let pathShimPath: string | null = null;
  if (platform !== "win32") {
    const pathEnv = options.pathEnv ?? (await resolveCliInstallPathEnv()) ?? "";
    pathShimPath = await installPathShimIfPossible({
      canonicalShimPath: shimPath,
      commandName: isPackaged ? "tutti" : "tutti-dev",
      development: !isPackaged,
      homeDir: options.homeDir ?? homedir(),
      pathEnv,
      platform,
      stateRootDir
    });
  }

  return {
    installed: true,
    pathShimPath,
    shimPath
  };
}

export function resolveUserShimPath(
  stateRootDir: string,
  platform: NodeJS.Platform = process.platform,
  options: { development?: boolean } = {}
): string {
  const commandName = options.development ? "tutti-dev" : "tutti";
  return join(
    stateRootDir,
    "bin",
    platform === "win32" ? `${commandName}.cmd` : commandName
  );
}

async function writeUnixShim(
  shimPath: string,
  packagedCliPath: string,
  stateRootDir: string,
  options: { development?: boolean } = {}
): Promise<void> {
  await rm(shimPath, { force: true, recursive: false });
  await writeFile(
    shimPath,
    [
      "#!/usr/bin/env sh",
      options.development ? "# Tutti dev CLI shim" : "# Tutti CLI shim",
      `if [ -z "\${TUTTI_STATE_DIR:-}" ]; then export TUTTI_STATE_DIR=${shellQuoteValue(stateRootDir)}; fi`,
      `exec ${shellQuoteValue(packagedCliPath)} "$@"`,
      ""
    ].join("\n"),
    "utf8"
  );
  await chmod(shimPath, 0o755);
}

async function writeWindowsShim(
  shimPath: string,
  packagedCliPath: string,
  stateRootDir: string,
  options: { development?: boolean } = {}
): Promise<void> {
  const body = [
    "@echo off",
    options.development ? "rem Tutti dev CLI shim" : "rem Tutti CLI shim",
    `if "%TUTTI_STATE_DIR%"=="" set "TUTTI_STATE_DIR=${stateRootDir}"`,
    `"${packagedCliPath}" %*`,
    ""
  ].join("\r\n");
  await rm(shimPath, { force: true, recursive: false });
  await writeFile(shimPath, body, "utf8");
  await chmod(shimPath, 0o755);
}

async function resolveCliInstallPathEnv(): Promise<string | null> {
  try {
    // Finder-launched apps can inherit a smaller PATH than the login shell.
    const shellEnv = await resolveCachedUserShellEnv();
    return shellEnv.PATH?.trim() || process.env.PATH?.trim() || null;
  } catch {
    return process.env.PATH?.trim() || null;
  }
}

async function installPathShimIfPossible(input: {
  canonicalShimPath: string;
  commandName: string;
  development: boolean;
  homeDir: string;
  pathEnv: string;
  platform: NodeJS.Platform;
  stateRootDir: string;
}): Promise<string | null> {
  const pathDirs = pathDirectories(input.pathEnv, input.platform);
  if (await includesSamePath(pathDirs, dirname(input.canonicalShimPath))) {
    return input.canonicalShimPath;
  }

  const existingCommand = await findExistingPathCommand(
    pathDirs,
    input.commandName
  );
  if (existingCommand) {
    if (!(await isOwnedCliShim(existingCommand))) {
      return null;
    }
    await writePathShim(existingCommand, input);
    return existingCommand;
  }

  const targetDir = await firstWritableUserPathDir(pathDirs, input.homeDir);
  if (!targetDir) {
    return null;
  }

  const pathShimPath = join(targetDir, input.commandName);
  await writePathShim(pathShimPath, input);
  return pathShimPath;
}

async function writePathShim(
  pathShimPath: string,
  input: {
    canonicalShimPath: string;
    development: boolean;
    platform: NodeJS.Platform;
    stateRootDir: string;
  }
): Promise<void> {
  if (input.platform === "win32") {
    await writeWindowsShim(
      pathShimPath,
      input.canonicalShimPath,
      input.stateRootDir,
      { development: input.development }
    );
    return;
  }
  await writeUnixShim(
    pathShimPath,
    input.canonicalShimPath,
    input.stateRootDir,
    { development: input.development }
  );
}

async function findExistingPathCommand(
  pathDirs: readonly string[],
  commandName: string
): Promise<string | null> {
  for (const pathDir of pathDirs) {
    const candidate = join(pathDir, commandName);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function firstWritableUserPathDir(
  pathDirs: readonly string[],
  homeDir: string
): Promise<string | null> {
  const resolvedPathDirs = new Set(pathDirs.map((pathDir) => resolve(pathDir)));
  for (const candidate of [
    join(homeDir, ".local", "bin"),
    join(homeDir, "bin")
  ]) {
    const resolvedCandidate = resolve(candidate);
    if (!resolvedPathDirs.has(resolvedCandidate)) {
      continue;
    }
    try {
      await mkdir(resolvedCandidate, { recursive: true });
      await access(resolvedCandidate, constants.W_OK);
      return resolvedCandidate;
    } catch {
      // Keep scanning stable user-owned PATH locations.
    }
  }
  return null;
}

async function isOwnedCliShim(path: string): Promise<boolean> {
  try {
    const content = await readFile(path, "utf8");
    return (
      content.includes("Tutti CLI shim") ||
      content.includes("Tutti dev CLI shim")
    );
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirectories(pathEnv: string, platform: NodeJS.Platform): string[] {
  const separator = platform === "win32" ? ";" : delimiter;
  return pathEnv
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function includesSamePath(
  candidates: readonly string[],
  expected: string
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await samePath(candidate, expected)) {
      return true;
    }
  }
  return false;
}

async function samePath(left: string, right: string): Promise<boolean> {
  const [resolvedLeft, resolvedRight] = await Promise.all([
    canonicalizeExistingPath(left),
    canonicalizeExistingPath(right)
  ]);
  return resolvedLeft === resolvedRight;
}

async function canonicalizeExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function shellQuoteValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function ensureDevCliBinary(input: {
  goBin?: string;
  platform: NodeJS.Platform;
  repoRoot: string;
  targetPath: string;
}): void {
  if (existsSync(input.targetPath)) {
    return;
  }

  const cliDir = join(input.repoRoot, "apps", "cli");
  mkdirSync(dirname(input.targetPath), { recursive: true });
  const result = spawnSync(
    resolveCommand(
      input.goBin?.trim() || process.env.GO_BIN?.trim() || "go",
      input.platform
    ),
    ["build", "-o", input.targetPath, "./cmd/tutti"],
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
      `go build failed while installing tutti-dev with exit code ${
        result.status ?? "unknown"
      }`
    );
  }
}

function resolveCommand(command: string, platform: NodeJS.Platform): string {
  if (platform === "win32" && !command.toLowerCase().endsWith(".cmd")) {
    return `${command}.cmd`;
  }
  return command;
}

function resolveRepoRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  let candidate = currentDir;
  for (;;) {
    if (
      existsSync(join(candidate, "pnpm-workspace.yaml")) &&
      existsSync(join(candidate, "services", "tuttid"))
    ) {
      return candidate;
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      return resolve(currentDir, "../../../../");
    }
    candidate = parent;
  }
}
