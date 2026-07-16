import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ensureDesktopCliShim, resolveUserShimPath } from "./cliInstaller.ts";

test("ensureDesktopCliShim writes dev tutti-dev shim outside packaged app", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-cli-state-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "tutti-cli-repo-"));
  const builtCliPath = join(repoRoot, "apps", "cli", "build", "dev", "tutti");
  await mkdir(dirname(builtCliPath), { recursive: true });
  await writeFile(builtCliPath, "#!/bin/sh\n", "utf8");

  const state = await ensureDesktopCliShim({
    isPackaged: false,
    pathEnv: "",
    platform: "darwin",
    repoRoot,
    resourcesPath: "/Applications/Tutti.app/Contents/Resources",
    stateRootDir
  });

  assert.equal(state.installed, true);
  assert.equal(state.pathShimPath, null);
  assert.equal(state.shimPath, join(stateRootDir, "bin", "tutti-dev"));
  const content = await readFile(state.shimPath, "utf8");
  assert.match(content, /Tutti dev CLI shim/);
  assert.match(content, new RegExp(escapeRegExp(builtCliPath)));
});

test("ensureDesktopCliShim writes unix shim with state root", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-cli-state-"));
  const homeDir = await mkdtemp(join(tmpdir(), "tutti-cli-home-"));
  const localBinDir = join(homeDir, ".local", "bin");
  await mkdir(localBinDir, { recursive: true });
  const shimPath = resolveUserShimPath(stateRootDir, "darwin");
  await mkdir(join(stateRootDir, "bin"), { recursive: true });
  await writeFile(shimPath, "stale", "utf8");

  const state = await ensureDesktopCliShim({
    isPackaged: true,
    homeDir,
    pathEnv: `${localBinDir}:/usr/bin:/bin`,
    platform: "darwin",
    resourcesPath: "/Applications/Tutti.app/Contents/Resources",
    stateRootDir
  });

  assert.equal(state.installed, true);
  const pathShimPath = join(localBinDir, "tutti");
  assert.equal(state.pathShimPath, pathShimPath);
  const content = await readFile(shimPath, "utf8");
  assert.match(content, /Tutti CLI shim/);
  assert.match(
    content,
    /\/Applications\/Tutti\.app\/Contents\/Resources\/bin\/tutti/
  );
  assert.match(content, new RegExp(escapeRegExp(stateRootDir)));
  const pathShimContent = await readFile(pathShimPath, "utf8");
  assert.match(pathShimContent, /Tutti CLI shim/);
  assert.match(pathShimContent, new RegExp(escapeRegExp(shimPath)));
});

test("ensureDesktopCliShim writes windows command shim", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-cli-state-"));
  const homeDir = await mkdtemp(join(tmpdir(), "tutti-cli-home-"));
  const localBinDir = join(homeDir, ".local", "bin");
  await mkdir(localBinDir, { recursive: true });

  const state = await ensureDesktopCliShim({
    homeDir,
    isPackaged: true,
    pathEnv: `${localBinDir};C:\\Windows\\System32`,
    platform: "win32",
    resourcesPath: "C:\\Program Files\\Tutti\\resources",
    stateRootDir
  });

  assert.equal(state.installed, true);
  assert.equal(state.pathShimPath, null);
  assert.equal(state.shimPath, join(stateRootDir, "bin", "tutti.cmd"));
  const content = await readFile(state.shimPath, "utf8");
  assert.match(content, /tutti\.exe/);
  assert.match(content, new RegExp(escapeRegExp(stateRootDir)));
});

test("ensureDesktopCliShim keeps an existing non-Tutti PATH command", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-cli-state-"));
  const homeDir = await mkdtemp(join(tmpdir(), "tutti-cli-home-"));
  const localBinDir = join(homeDir, ".local", "bin");
  const existingCommandPath = join(localBinDir, "tutti");
  const existingContent = "#!/bin/sh\necho external-tutti\n";
  await mkdir(localBinDir, { recursive: true });
  await writeFile(existingCommandPath, existingContent, "utf8");

  const state = await ensureDesktopCliShim({
    homeDir,
    isPackaged: true,
    pathEnv: `${localBinDir}:/usr/bin:/bin`,
    platform: "darwin",
    resourcesPath: "/Applications/Tutti.app/Contents/Resources",
    stateRootDir
  });

  assert.equal(state.installed, true);
  assert.equal(state.pathShimPath, null);
  assert.equal(await readFile(existingCommandPath, "utf8"), existingContent);
});

test("ensureDesktopCliShim repairs an existing Tutti-owned PATH shim", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-cli-state-"));
  const homeDir = await mkdtemp(join(tmpdir(), "tutti-cli-home-"));
  const localBinDir = join(homeDir, ".local", "bin");
  const existingCommandPath = join(localBinDir, "tutti");
  await mkdir(localBinDir, { recursive: true });
  await writeFile(
    existingCommandPath,
    "#!/bin/sh\n# Tutti CLI shim\nexec '/stale/tutti' \"$@\"\n",
    "utf8"
  );

  const state = await ensureDesktopCliShim({
    homeDir,
    isPackaged: true,
    pathEnv: `${localBinDir}:/usr/bin:/bin`,
    platform: "darwin",
    resourcesPath: "/Applications/Tutti.app/Contents/Resources",
    stateRootDir
  });

  assert.equal(state.pathShimPath, existingCommandPath);
  const content = await readFile(existingCommandPath, "utf8");
  assert.doesNotMatch(content, /\/stale\/tutti/);
  assert.match(
    content,
    new RegExp(escapeRegExp(join(stateRootDir, "bin", "tutti")))
  );
});

test("ensureDesktopCliShim uses the canonical shim when it is already on PATH", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-cli-state-"));
  const canonicalBinDir = join(stateRootDir, "bin");

  const state = await ensureDesktopCliShim({
    isPackaged: true,
    pathEnv: `${canonicalBinDir}:/usr/bin:/bin`,
    platform: "darwin",
    resourcesPath: "/Applications/Tutti.app/Contents/Resources",
    stateRootDir
  });

  assert.equal(state.pathShimPath, join(canonicalBinDir, "tutti"));
});

test("ensureDesktopCliShim recognizes a PATH symlink to the canonical bin directory", async () => {
  const stateRootDir = await mkdtemp(join(tmpdir(), "tutti-cli-state-"));
  const homeDir = await mkdtemp(join(tmpdir(), "tutti-cli-home-"));
  const canonicalBinDir = join(stateRootDir, "bin");
  const localDir = join(homeDir, ".local");
  const linkedBinDir = join(localDir, "bin");
  await mkdir(canonicalBinDir, { recursive: true });
  await mkdir(localDir, { recursive: true });
  await symlink(canonicalBinDir, linkedBinDir);

  const state = await ensureDesktopCliShim({
    homeDir,
    isPackaged: true,
    pathEnv: `${linkedBinDir}:/usr/bin:/bin`,
    platform: "darwin",
    resourcesPath: "/Applications/Tutti.app/Contents/Resources",
    stateRootDir
  });

  assert.equal(state.pathShimPath, join(canonicalBinDir, "tutti"));
  const content = await readFile(state.shimPath, "utf8");
  assert.match(
    content,
    /\/Applications\/Tutti\.app\/Contents\/Resources\/bin\/tutti/
  );
  assert.doesNotMatch(
    content,
    new RegExp(`exec '${escapeRegExp(state.shimPath)}'`)
  );
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
