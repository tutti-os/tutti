import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = join(scriptDirectory, "..", "..");
const workspaceRoot = process.env.TUTTI_WORKSPACE_ROOT ?? defaultWorkspaceRoot;
const rendererRoot =
  process.env.TUTTI_RENDERER_ROOT ?? "apps/desktop/src/renderer/src";
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "dist",
  "node_modules",
  "out"
]);
const stagedOnly = process.argv.includes("--staged");
const textExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const violations = [];

if (stagedOnly) {
  await scanStagedFiles();
} else {
  await walk(join(workspaceRoot, rendererRoot));
}

if (violations.length > 0) {
  console.error("Found renderer feature boundary violations:");
  for (const violation of violations) {
    console.error(
      `- [${violation.rule}] ${violation.file}:${violation.line} ${violation.message}`
    );
  }

  process.exitCode = 1;
} else {
  console.log("renderer feature boundary check passed");
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walk(path);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = toPosixPath(relative(workspaceRoot, path));
    await inspectFile(relativePath, path);
  }
}

async function scanStagedFiles() {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    {
      cwd: workspaceRoot,
      encoding: "utf8"
    }
  );

  const files = output
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => file.startsWith(`${rendererRoot}/`));

  for (const relativePath of files) {
    await inspectFile(relativePath, join(workspaceRoot, relativePath));
  }
}

async function inspectFile(relativePath, absolutePath) {
  if (!hasTextExtension(relativePath)) {
    return;
  }

  const content = await readFile(absolutePath, "utf8");
  inspectCodeFile(relativePath, content);
}

function inspectCodeFile(relativePath, content) {
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    for (const specifier of matchImportSpecifiers(lines[index])) {
      inspectImport(relativePath, specifier, index + 1);
    }

    inspectWindowTuttiAccess(relativePath, lines[index], index + 1);
    inspectWorkspaceLaunchCoordinatorMap(relativePath, lines[index], index + 1);
  }
}

function inspectWorkspaceLaunchCoordinatorMap(relativePath, lineContent, line) {
  if (!isWorkspaceLaunchCoordinator(relativePath)) {
    return;
  }

  if (!/\bnew\s+Map\s*(?:<|\()/u.test(lineContent)) {
    return;
  }

  violations.push({
    file: relativePath,
    line,
    message:
      "workspace launch coordinators must use WorkspaceScopedRegistrationRegistry instead of owning a Map",
    rule: "workspace-launch-coordinator-private-map"
  });
}

function isWorkspaceLaunchCoordinator(relativePath) {
  const servicesRoot = `${rendererRoot}/features/workspace-workbench/services/`;
  if (!relativePath.startsWith(servicesRoot)) {
    return false;
  }

  const servicePath = relativePath.slice(servicesRoot.length);
  if (servicePath.includes("/")) {
    return false;
  }

  return (
    servicePath.endsWith("LaunchCoordinator.ts") ||
    servicePath === "workspaceMessageCenterCoordinator.ts"
  );
}

function inspectImport(importerPath, specifier, line) {
  const targetPath = resolveRendererSpecifier(importerPath, specifier);
  if (!targetPath) {
    return;
  }

  inspectWorkspaceWorkbenchUiInternalImport(
    importerPath,
    targetPath,
    specifier,
    line
  );

  const internalMatch = targetPath.match(
    /^apps\/desktop\/src\/renderer\/src\/features\/([^/]+)\/services\/internal(?:\/|$)/
  );
  if (!internalMatch) {
    return;
  }

  const targetFeature = internalMatch[1];
  const allowedPrefix = `apps/desktop/src/renderer/src/features/${targetFeature}/`;
  if (importerPath.startsWith(allowedPrefix)) {
    return;
  }

  violations.push({
    file: importerPath,
    line,
    message: `cross-feature import of ${targetFeature}/services/internal is not allowed: ${specifier}`,
    rule: "feature-internal-import"
  });
}

function inspectWorkspaceWorkbenchUiInternalImport(
  importerPath,
  targetPath,
  specifier,
  line
) {
  const workbenchFeatureRoot = `${rendererRoot}/features/workspace-workbench/`;
  if (!importerPath.startsWith(`${workbenchFeatureRoot}ui/`)) {
    return;
  }

  if (!targetPath.startsWith(`${workbenchFeatureRoot}services/internal/`)) {
    return;
  }

  violations.push({
    file: importerPath,
    line,
    message: `workspace workbench UI must use public service/controller seams instead of importing services/internal: ${specifier}`,
    rule: "workspace-workbench-ui-internal-import"
  });
}

function inspectWindowTuttiAccess(relativePath, lineContent, line) {
  if (!/\bwindow\s*\.\s*tutti\b/.test(lineContent)) {
    return;
  }

  if (canAccessRendererPreloadApi(relativePath)) {
    return;
  }

  violations.push({
    file: relativePath,
    line,
    message:
      "renderer code must receive DesktopApi through window composition instead of reading window.tutti directly",
    rule: "renderer-window-tutti-access"
  });
}

function canAccessRendererPreloadApi(relativePath) {
  if (relativePath === `${rendererRoot}/global.d.ts`) {
    return true;
  }

  const windowsRoot = `${rendererRoot}/app/windows/`;
  if (!relativePath.startsWith(windowsRoot)) {
    return false;
  }

  return /^create[A-Z][^/]*Container\.ts$/.test(
    relativePath.slice(windowsRoot.length).split("/").at(-1) ?? ""
  );
}

function resolveRendererSpecifier(importerPath, specifier) {
  if (specifier.startsWith("@renderer/")) {
    return normalizePosix(
      `${rendererRoot}/${specifier.slice("@renderer/".length)}`
    );
  }

  if (specifier.startsWith(".")) {
    return normalizePosix(join(dirname(importerPath), specifier));
  }

  return null;
}

function hasTextExtension(path) {
  return Array.from(textExtensions).some((extension) =>
    path.endsWith(extension)
  );
}

function matchImportSpecifiers(line) {
  const matches = line.matchAll(
    /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g
  );
  return Array.from(matches, (match) => match[1] ?? match[2]).filter(Boolean);
}

function normalizePosix(path) {
  return toPosixPath(normalize(path));
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}
