import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function resolveGolangciLintBinary({
  cwd = process.cwd(),
  pathExists = existsSync,
  platform = process.platform,
  spawnSyncImpl = spawnSync
} = {}) {
  const command = platform === "win32" ? "golangci-lint.exe" : "golangci-lint";
  const result = spawnSyncImpl("go", ["env", "GOPATH"], {
    cwd,
    encoding: "utf8"
  });
  if (result.error?.code === "ENOENT" || result.status !== 0) {
    return command;
  }

  for (const goPath of String(result.stdout ?? "")
    .trim()
    .split(delimiter)
    .filter(Boolean)) {
    const candidate = join(goPath, "bin", command);
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return command;
}
