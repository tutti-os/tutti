import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const searchRoots = ["apps", "packages", "tools"];
const ignoredDirectories = new Set([
  ".git",
  ".tutti-ui-system-dev",
  ".turbo",
  "dist",
  "node_modules",
  "out"
]);
const ignoredFiles = new Set(["tools/scripts/check-ui-boundaries.mjs"]);
const ignoredPathPrefixes = [];
const stagedOnly = process.argv.includes("--staged");

const allowedUISystemSpecifiers = new Set([
  "@tutti-os/ui-system",
  "@tutti-os/ui-system/components",
  "@tutti-os/ui-system/icons",
  "@tutti-os/ui-system/metadata",
  "@tutti-os/ui-system/styles.css",
  "@tutti-os/ui-system/utils"
]);
const uiSystemDevViteSpecifier = "@tutti-os/ui-system/dev-vite";
const forbiddenUISystemPrefixes = [
  "@tutti-os/ui-system/src/",
  "@tutti-os/ui-system/lib/",
  "@tutti-os/ui-system/hooks/",
  "@tutti-os/ui-system/components/",
  "@tutti-os/ui-system/icons/"
];
const allowedCssFiles = new Set([
  "apps/desktop/src/renderer/src/style.css",
  "apps/ui-storyboard/src/style.css",
  "packages/agent/gui/app/renderer/agentactivity.css",
  "packages/workspace/terminal/src/styles/terminal.css",
  "packages/workbench/surface/src/styles/workbench.css",
  "tools/fixtures/ui-system-external-vite/src/style.css"
]);
const allowedCssPrefixes = [
  "packages/ui/system/src/styles/",
  "packages/ui/rich-text/src/at-panel/"
];
const allowedRawSvgPrefixes = [
  "packages/ui/system/src/icons/",
  "packages/agent/gui/"
];
const allowedExternalIconImportPrefixes = [
  "packages/ui/system/src/icons/",
  "packages/agent/gui/"
];
const externalIconImportPattern =
  /(?:from\s*["']|import\s*\(\s*["'])(lucide-react|@radix-ui\/react-icons|react-icons(?:\/[^"'`\s)]+)?)/g;
const rendererCodeRoot = "apps/desktop/src/renderer/src/";
const rendererStyleEntryPath = "apps/desktop/src/renderer/src/style.css";
const thinTailwindStyleEntryPaths = new Set([
  rendererStyleEntryPath,
  "apps/ui-storyboard/src/style.css"
]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx"
]);
const rendererStyleDirectoryPath = dirname(rendererStyleEntryPath);
const styleSourcesByEntryPath = new Map();
const usedRendererTailwindSourcePackages = new Set();
const packageTailwindSourceRequirements =
  await loadPackageTailwindSourceRequirements();
const inspectedFiles = new Set();

const violations = [];

if (stagedOnly) {
  await scanStagedFiles();
} else {
  for (const root of searchRoots) {
    await walk(join(workspaceRoot, root));
  }
}

validateRendererTailwindSources();

if (violations.length > 0) {
  console.error("Found frontend boundary violations:");
  for (const violation of violations) {
    console.error(
      `- [${violation.rule}] ${violation.file}:${violation.line} ${violation.message}`
    );
  }

  process.exitCode = 1;
} else {
  runUIMetadataCheck();
  console.log("ui boundary check passed");
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

    const relativePath = normalizePosix(relative(workspaceRoot, path));
    if (isIgnoredPath(relativePath)) {
      continue;
    }

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
    .filter((file) => isTrackedSearchRoot(file))
    .filter((file) => !isIgnoredPath(file));

  for (const relativePath of files) {
    await inspectFile(relativePath, join(workspaceRoot, relativePath));
  }

  if (!inspectedFiles.has(rendererStyleEntryPath)) {
    await inspectFile(
      rendererStyleEntryPath,
      join(workspaceRoot, rendererStyleEntryPath)
    );
  }
}

async function inspectFile(relativePath, absolutePath) {
  if (inspectedFiles.has(relativePath)) {
    return;
  }
  inspectedFiles.add(relativePath);

  if (relativePath.endsWith(".css")) {
    await inspectCssFile(relativePath, absolutePath);
    return;
  }

  if (relativePath.endsWith(".svg")) {
    inspectSvgAsset(relativePath);
    return;
  }

  if (!hasTextExtension(relativePath)) {
    return;
  }

  const content = await readFile(absolutePath, "utf8");
  inspectCodeFile(relativePath, content);
}

async function inspectCssFile(relativePath, absolutePath) {
  if (!isAllowedCssFile(relativePath)) {
    violations.push({
      file: relativePath,
      line: 1,
      message:
        "custom .css files are only allowed in packages/ui/system/src/styles/*, packages/workbench/surface/src/styles/workbench.css, packages/workspace/terminal/src/styles/terminal.css, packages/agent/gui/app/renderer/agentactivity.css, apps/desktop/src/renderer/src/style.css, apps/ui-storyboard/src/style.css, and approved fixtures",
      rule: "css-file"
    });
    return;
  }

  const content = await readFile(absolutePath, "utf8");

  if (thinTailwindStyleEntryPaths.has(relativePath)) {
    const lines = content.split("\n");
    const styleSources = new Map();
    styleSourcesByEntryPath.set(relativePath, styleSources);

    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (
        trimmed.length === 0 ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("//")
      ) {
        continue;
      }

      if (!trimmed.startsWith("@import ") && !trimmed.startsWith("@source ")) {
        violations.push({
          file: relativePath,
          line: index + 1,
          message:
            "style.css should stay a thin Tailwind entrypoint with only @import/@source directives",
          rule: "css-entrypoint"
        });
      }

      const sourceMatch = trimmed.match(/^@source\s+["']([^"']+)["'];?$/);
      if (!sourceMatch) {
        continue;
      }

      const resolvedSourcePath = normalizePosix(
        relative(workspaceRoot, join(dirname(absolutePath), sourceMatch[1]))
      );
      styleSources.set(resolvedSourcePath, {
        line: index + 1,
        sourceLiteral: sourceMatch[1]
      });
    }
  }
}

function inspectSvgAsset(relativePath) {
  if (allowedRawSvgPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
    return;
  }

  violations.push({
    file: relativePath,
    line: 1,
    message: ".svg assets must live under packages/ui/system/src/icons/",
    rule: "svg-asset"
  });
}

function inspectCodeFile(relativePath, content) {
  inspectDevViteImports(relativePath, content);

  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (relativePath.startsWith(rendererCodeRoot)) {
      for (const specifier of matchImportSpecifiers(line)) {
        registerRendererTailwindSourcePackageUsage(specifier);
      }
    }

    for (const specifier of matchUISystemSpecifiers(line)) {
      if (specifier === uiSystemDevViteSpecifier) {
        continue;
      }

      if (allowedUISystemSpecifiers.has(specifier)) {
        continue;
      }

      if (
        !forbiddenUISystemPrefixes.some((prefix) =>
          specifier.startsWith(prefix)
        )
      ) {
        continue;
      }

      violations.push({
        file: relativePath,
        line: index + 1,
        message: `invalid ui-system deep import: ${specifier}. Use one of: ${Array.from(allowedUISystemSpecifiers).join(", ")}`,
        rule: "ui-system-import"
      });
    }

    if (
      line.includes("<svg") &&
      !allowedRawSvgPrefixes.some((prefix) => relativePath.startsWith(prefix))
    ) {
      violations.push({
        file: relativePath,
        line: index + 1,
        message:
          "raw <svg> markup is only allowed under packages/ui/system/src/icons/",
        rule: "svg-inline"
      });
    }

    for (const specifier of matchExternalIconImports(line)) {
      if (
        allowedExternalIconImportPrefixes.some((prefix) =>
          relativePath.startsWith(prefix)
        )
      ) {
        continue;
      }

      violations.push({
        file: relativePath,
        line: index + 1,
        message: `external icon package import ${specifier} is only allowed inside packages/ui/system/src/icons/`,
        rule: "icon-import"
      });
    }
  }
}

function inspectDevViteImports(relativePath, content) {
  if (isAllowedDevViteImporter(relativePath)) {
    return;
  }

  for (const match of matchImportSpecifierLocations(content)) {
    if (match.specifier !== uiSystemDevViteSpecifier) {
      continue;
    }

    violations.push({
      file: relativePath,
      line: match.line,
      message:
        "@tutti-os/ui-system/dev-vite may only be imported from bundler config or tooling files",
      rule: "ui-system-dev-vite-import"
    });
  }
}

function registerRendererTailwindSourcePackageUsage(specifier) {
  for (const packageName of packageTailwindSourceRequirements.keys()) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      usedRendererTailwindSourcePackages.add(packageName);
    }
  }
}

function hasTextExtension(path) {
  return Array.from(textExtensions).some((extension) =>
    path.endsWith(extension)
  );
}

function isTrackedSearchRoot(path) {
  return searchRoots.some(
    (root) => path === root || path.startsWith(`${root}/`)
  );
}

function isIgnoredPath(relativePath) {
  return (
    ignoredFiles.has(relativePath) ||
    ignoredPathPrefixes.some((prefix) => relativePath.startsWith(prefix))
  );
}

function isAllowedCssFile(relativePath) {
  return (
    allowedCssFiles.has(relativePath) ||
    allowedCssPrefixes.some((prefix) => relativePath.startsWith(prefix))
  );
}

function isAllowedDevViteImporter(relativePath) {
  return (
    relativePath === "vite.config.ts" ||
    relativePath === "vite.config.mts" ||
    relativePath.endsWith("/vite.config.ts") ||
    relativePath.endsWith("/vite.config.mts") ||
    relativePath === "electron.vite.config.ts" ||
    relativePath.endsWith("/electron.vite.config.ts") ||
    relativePath.startsWith(
      "packages/ui/system/agent/tutti-ui-system/scripts/"
    ) ||
    relativePath.startsWith("tools/scripts/") ||
    relativePath.startsWith("scripts/")
  );
}

function matchUISystemSpecifiers(line) {
  const matches = line.matchAll(/@tutti-os\/ui-system(?:\/[^"'`\s,)]+)?/g);
  return Array.from(matches, (match) => match[0]);
}

function matchExternalIconImports(line) {
  const matches = line.matchAll(externalIconImportPattern);
  return Array.from(matches, (match) => match[1]);
}

function matchImportSpecifiers(line) {
  const matches = line.matchAll(
    /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g
  );
  return Array.from(matches, (match) => match[1] ?? match[2]).filter(Boolean);
}

function matchImportSpecifierLocations(content) {
  const matches = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      const specifierIndex = match.index + match[0].lastIndexOf(specifier);

      matches.push({
        line: lineNumberAt(content, specifierIndex),
        specifier
      });
    }
  }

  return matches;
}

function lineNumberAt(content, index) {
  let line = 1;

  for (let offset = 0; offset < index; offset += 1) {
    if (content[offset] === "\n") {
      line += 1;
    }
  }

  return line;
}

function normalizePosix(path) {
  return path.split(sep).join("/");
}

async function loadPackageTailwindSourceRequirements() {
  const requirements = new Map();
  await walkPackageDirectory(join(workspaceRoot, "packages"), requirements);
  return requirements;
}

async function walkPackageDirectory(directory, requirements) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await walkPackageDirectory(path, requirements);
      }
      continue;
    }

    if (!entry.isFile() || entry.name !== "package.json") {
      continue;
    }

    const relativeManifestPath = normalizePosix(relative(workspaceRoot, path));
    const packageDirectoryPath = dirname(relativeManifestPath);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const tailwindSourceRoot = manifest.tutti?.tailwindSourceRoot;

    if (
      typeof manifest.name !== "string" ||
      typeof tailwindSourceRoot !== "string" ||
      tailwindSourceRoot.trim().length === 0
    ) {
      continue;
    }

    requirements.set(manifest.name, {
      packageDirectoryPath,
      sourcePath: normalizePosix(join(packageDirectoryPath, tailwindSourceRoot))
    });
  }
}

function validateRendererTailwindSources() {
  const rendererStyleSources =
    styleSourcesByEntryPath.get(rendererStyleEntryPath) ?? new Map();

  for (const packageName of usedRendererTailwindSourcePackages) {
    const requirement = packageTailwindSourceRequirements.get(packageName);
    if (!requirement) {
      continue;
    }

    if (rendererStyleSources.has(requirement.sourcePath)) {
      continue;
    }

    const expectedSourceLiteral = normalizePosix(
      relative(rendererStyleDirectoryPath, requirement.sourcePath)
    );
    const mismatchedSourceEntry = findRendererSourceEntryForPackage(
      rendererStyleSources,
      requirement.packageDirectoryPath
    );

    if (mismatchedSourceEntry) {
      violations.push({
        file: rendererStyleEntryPath,
        line: mismatchedSourceEntry.line,
        message: `renderer style.css has the wrong @source for ${packageName}. Expected "@source \\"${expectedSourceLiteral}\\";" but found "@source \\"${mismatchedSourceEntry.sourceLiteral}\\";".`,
        rule: "tailwind-source"
      });
      continue;
    }

    violations.push({
      file: rendererStyleEntryPath,
      line: 1,
      message: `renderer style.css is missing @source for ${packageName}. Add: @source "${expectedSourceLiteral}";`,
      rule: "tailwind-source"
    });
  }
}

function findRendererSourceEntryForPackage(styleSources, packageDirectoryPath) {
  for (const [sourcePath, entry] of styleSources.entries()) {
    if (
      sourcePath === packageDirectoryPath ||
      sourcePath.startsWith(`${packageDirectoryPath}/`)
    ) {
      return entry;
    }
  }

  return null;
}

function runUIMetadataCheck() {
  try {
    execFileSync(process.execPath, ["tools/scripts/check-ui-metadata.mjs"], {
      cwd: workspaceRoot,
      stdio: "inherit"
    });
  } catch (error) {
    process.exit(error.status ?? 1);
  }
}
