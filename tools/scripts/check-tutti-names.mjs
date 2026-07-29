import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");

const forbiddenNameParts = [
  ["n", "e", "t", "o", "p"],
  ["n", "e", "x", "t", "o", "p"]
];
const legacyTokens = forbiddenNameParts.flatMap((parts) => {
  const lower = parts.join("");
  const title = lower[0].toUpperCase() + lower.slice(1);
  return [lower, title, lower.toUpperCase()];
});

const ignoredPrefixes = [
  "node_modules/",
  "dist/",
  "out/",
  "coverage/",
  "apps/desktop/build/",
  "apps/cli/build/"
];

const allowedLegacyContentFiles = new Set([
  "packages/auth/bridge/src/shared.ts",
  "packages/auth/bridge-go/authbridge.go",
  // Removed workspace-root contracts are still explicitly stripped so old
  // inherited or caller-provided environment values cannot reach apps.
  "services/tuttid/service/workspace/app_runtime_env.go",
  "services/tuttid/service/workspace/app_runtime_env_test.go",
  "services/tuttid/service/workspace/apps_runner_test.go"
]);

export function findLegacyNameViolations(files, readFile) {
  const violations = [];

  for (const file of files) {
    if (legacyTokens.some((token) => file.includes(token))) {
      violations.push(file);
      continue;
    }
    const content = readFile(file);
    if (!legacyTokens.some((token) => content.includes(token))) {
      continue;
    }
    if (!allowedLegacyContentFiles.has(file)) {
      violations.push(file);
    }
  }

  return violations;
}

if (isMainModule()) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: workspaceRoot,
      encoding: "utf8"
    }
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (file) => !ignoredPrefixes.some((prefix) => file.startsWith(prefix))
    )
    .filter((file) => existsSync(join(workspaceRoot, file)));
  const violations = findLegacyNameViolations(files, (file) =>
    readFileSync(join(workspaceRoot, file), "utf8")
  );

  if (violations.length > 0) {
    console.error("Unexpected legacy product tokens found:");
    for (const file of violations) {
      console.error(`- ${relative(workspaceRoot, join(workspaceRoot, file))}`);
    }
    console.error("Move references to Tutti naming before merging.");
    process.exitCode = 1;
  }
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])
  );
}
