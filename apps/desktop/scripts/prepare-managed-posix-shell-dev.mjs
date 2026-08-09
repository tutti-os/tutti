import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const runtimeRoot = join(scriptDir, "..", "build", "managed-posix-shell");
  const metadataPath = join(runtimeRoot, "runtime.json");

  if (!(await hasPreparedRuntime(metadataPath, runtimeRoot))) {
    const vendorScript = join(scriptDir, "vendor-managed-posix-shell.mjs");
    const result = spawnSync(
      process.execPath,
      [vendorScript, "--platform=windows-amd64"],
      { stdio: "inherit", windowsHide: true }
    );
    if (result.status !== 0) {
      throw result.error ?? new Error("prepare managed POSIX shell failed");
    }
  }
}

async function hasPreparedRuntime(metadataPath, runtimeRoot) {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (
      metadata.schemaVersion !== "tutti.managed-posix-shell.v1" ||
      typeof metadata.executable !== "string" ||
      metadata.executable.trim() !== metadata.executable ||
      metadata.executable === ""
    ) {
      return false;
    }
    await access(join(runtimeRoot, metadata.executable));
    return true;
  } catch {
    return false;
  }
}
