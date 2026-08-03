import { spawn } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const ignoredDirectories = new Set([
  ".git",
  "build",
  "dist",
  "node_modules",
  "out"
]);

export function isDesktopBundleFresh({ outputMtimeMs, sourceMtimeMs }) {
  return (
    Number.isFinite(outputMtimeMs) &&
    Number.isFinite(sourceMtimeMs) &&
    outputMtimeMs >= sourceMtimeMs
  );
}

export async function ensurePreparedDesktopLaunch({ workspaceRoot, log }) {
  const desktopRoot = join(workspaceRoot, "apps", "desktop");
  const outputFiles = [
    join(desktopRoot, "out", "main", "index.js"),
    join(desktopRoot, "out", "preload", "index.cjs"),
    join(desktopRoot, "out", "renderer", "index.html")
  ];
  const sourceMtimeMs = await latestSourceMtimeMs(workspaceRoot);
  const outputMtimeMs = await oldestMtimeMs(outputFiles);

  if (!isDesktopBundleFresh({ outputMtimeMs, sourceMtimeMs })) {
    log("building prepared Desktop bundle");
    await runCommand(
      "pnpm",
      ["--filter", "@tutti-os/desktop", "build"],
      workspaceRoot
    );
  } else {
    log("reusing prepared Desktop bundle");
  }

  const electronExecutable = createRequire(join(desktopRoot, "package.json"))(
    "electron"
  );
  return {
    args: [desktopRoot],
    command: electronExecutable,
    launchMode: "prebuilt"
  };
}

async function latestSourceMtimeMs(workspaceRoot) {
  const sourceRoots = [
    join(workspaceRoot, "apps", "desktop"),
    join(workspaceRoot, "packages"),
    join(workspaceRoot, "config"),
    join(workspaceRoot, "package.json"),
    join(workspaceRoot, "pnpm-lock.yaml")
  ];
  let latest = 0;
  for (const sourceRoot of sourceRoots) {
    latest = Math.max(latest, await treeMtimeMs(sourceRoot));
  }
  return latest;
}

async function treeMtimeMs(path) {
  let entry;
  try {
    entry = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  if (!entry.isDirectory()) return entry.mtimeMs;

  let latest = entry.mtimeMs;
  for (const child of await readdir(path, { withFileTypes: true })) {
    if (child.isDirectory() && ignoredDirectories.has(child.name)) continue;
    latest = Math.max(latest, await treeMtimeMs(join(path, child.name)));
  }
  return latest;
}

async function oldestMtimeMs(paths) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    try {
      await access(path);
      oldest = Math.min(oldest, (await stat(path)).mtimeMs);
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
  }
  return oldest;
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(" ")} failed (${code ?? signal ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`
        )
      );
    });
  });
}
