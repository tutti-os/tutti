import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
  "packages/auth/bridge-go/authbridge.go"
]);

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
  .filter((file) => !ignoredPrefixes.some((prefix) => file.startsWith(prefix)))
  .filter((file) => existsSync(join(workspaceRoot, file)));

const violations = [];

for (const file of files) {
  if (legacyTokens.some((token) => file.includes(token))) {
    violations.push(file);
    continue;
  }
  const content = readFileSync(join(workspaceRoot, file), "utf8");
  if (!legacyTokens.some((token) => content.includes(token))) {
    continue;
  }
  if (allowedLegacyContentFiles.has(file)) {
    continue;
  }
  violations.push(file);
}

if (violations.length > 0) {
  console.error("Unexpected legacy product tokens found:");
  for (const file of violations) {
    console.error(`- ${relative(workspaceRoot, join(workspaceRoot, file))}`);
  }
  console.error("Move references to Tutti naming before merging.");
  process.exitCode = 1;
}
