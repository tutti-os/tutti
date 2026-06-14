import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");

const legacyTokens = ["nextop", "Nextop", "NEXTOP"];
const allowedFiles = new Set([
  ".codex/skills/tutti-app-release/SKILL.md",
  ".github/workflows/desktop-release-notify.yml",
  ".github/workflows/desktop-release.yml",
  ".github/workflows/publish-tutti-app-catalog.yml",
  ".github/workflows/publish-tutti-app-catalog-staging.yml",
  ".github/workflows/publish-tutti-app-runtime.yml",
  "apps/cli/internal/defaults/defaults.go",
  "apps/cli/internal/defaults/defaults_test.go",
  "packages/agent/gui/shared/roomShare.ts",
  "packages/agent/gui/shared/roomShare.spec.ts",
  "tools/scripts/check-tutti-names.mjs",
  "services/tuttid/biz/workspace/apps.go",
  "services/tuttid/biz/workspace/apps_test.go",
  "services/tuttid/service/cli/appcli/manifest.go",
  "services/tuttid/service/cli/appcli/registry_test.go",
  "services/tuttid/service/workspace/app_archives.go",
  "services/tuttid/service/workspace/app_archives_test.go",
  "services/tuttid/service/workspace/app_factory_test.go",
  "services/tuttid/service/workspace/apps_runner.go",
  "services/tuttid/service/workspace/apps_runner_test.go",
  "services/tuttid/service/workspace/app_runtime_env.go",
  "services/tuttid/service/workspace/app_runtime_env_test.go",
  "services/tuttid/builtin-apps/catalog.go",
  "services/tuttid/builtin-apps/catalog_test.go",
  "services/tuttid/types/defaults.go",
  "services/tuttid/types/defaults_test.go",
  "tools/scripts/build-tutti-app-release.test.mjs",
  "tools/scripts/build-tutti-app-runtime-catalog.test.mjs",
  "tools/scripts/desktop-release-config.test.mjs"
]);

const ignoredPrefixes = [
  "node_modules/",
  "dist/",
  "out/",
  "coverage/",
  "apps/desktop/build/",
  "apps/cli/build/"
];

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
  const content = readFileSync(join(workspaceRoot, file), "utf8");
  if (!legacyTokens.some((token) => content.includes(token))) {
    continue;
  }
  if (allowedFiles.has(file)) {
    continue;
  }
  violations.push(file);
}

if (violations.length > 0) {
  console.error("Unexpected legacy Nextop tokens found:");
  for (const file of violations) {
    console.error(`- ${relative(workspaceRoot, join(workspaceRoot, file))}`);
  }
  console.error(
    "Move new references to Tutti naming, or add a narrowly justified compatibility file to the allowlist."
  );
  process.exitCode = 1;
}
