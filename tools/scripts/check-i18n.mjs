import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot =
  process.env.TUTTI_WORKSPACE_ROOT ?? join(scriptDirectory, "..", "..");
const locales = [
  { exportName: "en", file: "en.ts", locale: "en" },
  { exportName: "zhCN", file: "zh-CN.ts", locale: "zh-CN" }
];
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "dist",
  "node_modules",
  "out"
]);
// Manifest exports are discovered by shape, not by a script-side name registry:
// desktop-owned resources export `tuttiI18nModule`, and a reusable package may
// pick a package-specific name when that keeps its vocabulary product-neutral
// (docs/conventions/static-analysis.md, "such as browserNodeI18nModule"). A
// fixed list silently drops every package that chooses a name not on it, so any
// `export const <name>I18nModule` counts. Non-manifest matches are discarded by
// parseExportedObjectLiteral returning null.
const i18nModuleManifestExportPattern =
  /^[ \t]*export const ([A-Za-z$_][\w$]*I18nModule)\b/gm;
const i18nManifestSearchRoots = ["apps/desktop/src/shared/i18n", "packages"];
const localeResourceModules = discoverI18nModules();
const sourceRoots = [
  "apps/desktop/src/main",
  "apps/desktop/src/renderer/src",
  ...Array.from(
    new Set(
      localeResourceModules
        .map((module) => module.sourceRoot)
        .filter((value) => typeof value === "string" && value.length > 0)
    )
  )
];
const ignoredSourceFiles = new Set(
  localeResourceModules.flatMap((module) =>
    module.exportMode === "locale-object"
      ? Object.values(module.fileByLocale)
      : [module.manifestPath]
  )
);
const defaultLocale = locales[0].locale;
const stagedOnly = process.argv.includes("--staged");
const maxIssues = readMaxIssues(process.argv);
const ignoredPathSegments = ["/locales/", "/__tests__/", "/artifacts/"];
const ignoredFileSuffixes = [
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
  ".d.ts",
  // Shared fixture builders live beside the suites they serve rather than under
  // __tests__/, so the suffix carries the exemption the same way .test.ts does.
  "TestHarness.ts",
  "TestHarness.tsx"
];
const textExtensions = [".ts", ".tsx", ".js", ".jsx"];
const uiAttributeNames = ["aria-label", "title", "alt", "placeholder"];
const uiObjectPropertyPattern =
  /\b(ariaLabel|alt|buttonLabel|description|emptyText|helperText|label|message|placeholder|text|title|tooltip)\s*:\s*(["'`])([^"'`]+)\2/g;
const uiCallPattern =
  /\b(setError|setInputError|setMessage|setTitle|setDescription|setWarning|setSuccess)\s*\(\s*(["'`])([^"'`]+)\2/g;
const toastCallPattern =
  /\btoast\.(info|error|success|warning|message)\s*\(\s*(["'`])([^"'`]+)\2/g;
const i18nCallPatterns = [
  /(?<!\.)\b(?:t|translate)\(\s*(["'`])([^"'`]+)\1/g,
  /\b[\w$.]+\.t\(\s*(["'`])([^"'`]+)\1/g,
  /\btranslator\.t\(\s*(["'`])([^"'`]+)\1/g,
  /\btranslateMessage\(\s*(["'`])[^"'`]+\1\s*,\s*(["'`])([^"'`]+)\2/g
];
const allowedHardcodedCopy = new Set(["Tutti", "tutti"]);
const legacyKeyPattern = /(^|\.)(l\d+c\d+)$/;

const localeIssues = [];
const copyIssues = [];
const keyIssues = [];
const resources = loadLocaleResources();
const flattenedByLocale = flattenAllLocaleResources(resources);
const validKeys = flattenedByLocale.get(defaultLocale).keys;
const scopedValidKeysBySourceRoot = buildScopedValidKeysBySourceRoot(resources);

validateLocaleAlignment(flattenedByLocale);

const sourceFiles = stagedOnly
  ? listStagedSourceFiles()
  : await listAllSourceFiles();
for (const file of sourceFiles) {
  await inspectSourceFile(file);
}

const issues = [...localeIssues, ...copyIssues, ...keyIssues];
if (issues.length > 0) {
  console.error(`Found ${issues.length} i18n issue(s):`);
  for (const issue of issues.slice(0, maxIssues)) {
    console.error(
      `- [${issue.rule}] ${issue.file}:${issue.line} ${issue.message}`
    );
  }
  if (issues.length > maxIssues) {
    console.error(
      `... truncated ${issues.length - maxIssues} additional issue(s). Increase with --max-issues.`
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `i18n check passed for ${locales.length} locale(s), ${validKeys.size} key(s), and ${sourceFiles.length} source file(s).`
  );
}

function readMaxIssues(argv) {
  const index = argv.indexOf("--max-issues");
  if (index === -1) {
    return 200;
  }

  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--max-issues requires a positive integer");
  }
  return value;
}

function loadLocaleResources() {
  const result = new Map(locales.map((locale) => [locale.locale, []]));

  for (const module of localeResourceModules) {
    if (module.exportMode === "locale-object") {
      for (const locale of locales) {
        const relativePath = module.fileByLocale[locale.locale];
        const resource = parseExportedObjectLiteral(
          relativePath,
          locale.exportName
        );
        if (!resource) {
          continue;
        }

        result.get(locale.locale).push({
          file: relativePath,
          localValue: module.sourceRoot ? resource : undefined,
          module: module.name,
          sourceRoot: module.sourceRoot,
          value: resource
        });
      }
      continue;
    }

    if (module.exportMode === "scoped-locale-objects") {
      const namespace = module.namespace;
      if (!namespace) {
        continue;
      }

      for (const locale of locales) {
        const objectExportName = module.localeObjectByLocale[locale.locale];
        const localeObject = parseExportedObjectLiteral(
          module.manifestPath,
          objectExportName
        );
        if (!localeObject) {
          continue;
        }

        result.get(locale.locale).push({
          file: module.manifestPath,
          localValue: localeObject,
          module: module.name,
          sourceRoot: module.sourceRoot,
          value: {
            [namespace]: localeObject
          }
        });
      }
    }
  }

  return result;
}

function discoverI18nModules() {
  const manifests = [];

  for (const root of i18nManifestSearchRoots) {
    collectI18nModuleManifests(root, manifests);
  }

  return manifests.sort((left, right) =>
    left.manifestPath.localeCompare(right.manifestPath)
  );
}

function findI18nModuleExportNames(source) {
  const names = new Set();
  for (const match of source.matchAll(i18nModuleManifestExportPattern)) {
    names.add(match[1]);
  }

  return names;
}

function collectI18nModuleManifests(root, manifests) {
  const absoluteRoot = join(workspaceRoot, root);
  if (!existsSync(absoluteRoot)) {
    return;
  }

  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    const absolutePath = join(absoluteRoot, entry.name);
    const relativePath = toPosixPath(relative(workspaceRoot, absolutePath));

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collectI18nModuleManifests(relativePath, manifests);
      }
      continue;
    }

    if (!entry.isFile() || !relativePath.endsWith(".ts")) {
      continue;
    }

    const source = readFileSync(absolutePath, "utf8");
    for (const exportName of findI18nModuleExportNames(source)) {
      const manifest = parseExportedObjectLiteral(relativePath, exportName);
      if (!manifest) {
        continue;
      }

      manifests.push(normalizeI18nModuleManifest(relativePath, manifest));
    }
  }
}

function normalizeI18nModuleManifest(relativePath, manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Invalid i18n module manifest in ${relativePath}`);
  }

  if (manifest.exportMode === "locale-object") {
    return {
      exportMode: "locale-object",
      fileByLocale: manifest.fileByLocale,
      manifestPath: relativePath,
      name: manifest.name,
      sourceRoot: manifest.sourceRoot
    };
  }

  if (manifest.exportMode === "scoped-locale-objects") {
    return {
      exportMode: "scoped-locale-objects",
      localeObjectByLocale: manifest.localeObjectByLocale,
      manifestPath: relativePath,
      name: manifest.name,
      namespace: manifest.namespace,
      sourceRoot: manifest.sourceRoot
    };
  }

  throw new Error(`Unsupported i18n exportMode in ${relativePath}`);
}

function flattenAllLocaleResources(localeResources) {
  const result = new Map();

  for (const locale of locales) {
    const resourcesForLocale = localeResources.get(locale.locale);
    if (!resourcesForLocale) {
      continue;
    }

    const leaves = new Map();
    const files = [];
    for (const resource of resourcesForLocale) {
      files.push(resource.file);
      flattenTranslationLeaves(resource.value, "", leaves, resource.file);
    }
    result.set(locale.locale, {
      file: files[0] ?? "<unknown>",
      files,
      keys: new Set(leaves.keys()),
      leaves
    });
  }

  return result;
}

function buildScopedValidKeysBySourceRoot(localeResources) {
  const result = new Map();
  const resourcesForDefaultLocale = localeResources.get(defaultLocale) ?? [];

  for (const resource of resourcesForDefaultLocale) {
    if (!resource.sourceRoot || !resource.localValue) {
      continue;
    }

    const leaves = new Map();
    flattenTranslationLeaves(resource.localValue, "", leaves, resource.file);
    const scopedKeys = result.get(resource.sourceRoot) ?? new Set();
    for (const key of leaves.keys()) {
      scopedKeys.add(key);
    }
    result.set(resource.sourceRoot, scopedKeys);
  }

  return result;
}

function parseExportedObjectLiteral(
  relativePath,
  exportName,
  seen = new Set()
) {
  const absolutePath = join(workspaceRoot, relativePath);
  if (!existsSync(absolutePath)) {
    localeIssues.push({
      file: relativePath,
      line: 1,
      message: `Missing i18n resource file ${relativePath}`,
      rule: "locale-file-missing"
    });
    return null;
  }

  const source = readFileSync(absolutePath, "utf8");
  const importContext = createLocaleObjectImportContext(
    relativePath,
    source,
    seen
  );
  const helperMatch = source.match(
    new RegExp(
      `(?:export\\s+)?const\\s+${exportName}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)\\s*;`
    )
  );
  if (helperMatch) {
    return vm.runInNewContext(
      `${helperMatch[1]}(${helperMatch[2]})`,
      createI18nManifestVmContext(source)
    );
  }

  const match = source.match(
    new RegExp(
      `(?:export\\s+)?const\\s+${exportName}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*as\\s+const(?:\\s+satisfies\\s+[^;]+)?;`
    )
  );

  if (!match) {
    const plainObjectMatch = source.match(
      new RegExp(
        `(?:export\\s+)?const\\s+${exportName}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`
      )
    );
    if (!plainObjectMatch) {
      localeIssues.push({
        file: relativePath,
        line: 1,
        message: `Unable to parse locale export ${exportName}`,
        rule: "locale-parse"
      });
      return null;
    }

    return vm.runInNewContext(`(${plainObjectMatch[1]})`, importContext);
  }

  return vm.runInNewContext(`(${match[1]})`, importContext);
}

function createLocaleObjectImportContext(relativePath, source, seen) {
  const context = {};
  const nextSeen = new Set(seen);
  nextSeen.add(relativePath);
  const importPattern = /^import\s+\{([^}]+)\}\s+from\s+["'](\.[^"']+)["'];/gm;

  for (const match of source.matchAll(importPattern)) {
    const importPath = toImportSourcePath(relativePath, match[2]);
    if (nextSeen.has(importPath)) {
      continue;
    }

    for (const specifier of match[1].split(",")) {
      const trimmed = specifier.trim();
      if (!trimmed) {
        continue;
      }

      const [importedName, localName] = trimmed
        .split(/\s+as\s+/)
        .map((part) => part.trim());
      const value = parseExportedObjectLiteral(
        importPath,
        importedName,
        nextSeen
      );
      if (value) {
        context[localName ?? importedName] = value;
      }
    }
  }

  return context;
}

function toImportSourcePath(relativePath, importSpecifier) {
  const rawPath = toPosixPath(join(dirname(relativePath), importSpecifier));
  return rawPath.endsWith(".ts") ? rawPath : `${rawPath}.ts`;
}

// A manifest may name its namespace through a sibling constant
// (`namespace: richTextI18nNamespace`) instead of repeating the literal. The
// manifest expression is evaluated in isolation, so those constants have to be
// carried into the context or the evaluation throws ReferenceError. Only
// top-level double-quoted string constants are carried: enough for the
// namespace/name fields a manifest can reference, without evaluating the
// module.
function collectManifestStringConstants(source) {
  const constants = {};
  const pattern =
    /^[ \t]*(?:export\s+)?const\s+([A-Za-z$_][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*;/gm;
  for (const match of source.matchAll(pattern)) {
    try {
      constants[match[1]] = JSON.parse(match[2]);
    } catch {
      // Leave it undefined rather than guessing; an unresolved reference is
      // reported as an unparseable manifest by the caller.
    }
  }

  return constants;
}

function createI18nManifestVmContext(source = "") {
  return {
    ...collectManifestStringConstants(source),
    createLocaleObjectI18nModuleManifest(input) {
      return {
        exportMode: "locale-object",
        ...input
      };
    },
    createScopedLocaleObjectsI18nModuleManifest(input) {
      return {
        exportMode: "scoped-locale-objects",
        ...input
      };
    }
  };
}

function flattenTranslationLeaves(value, prefix, leaves, file) {
  if (typeof value === "string") {
    leaves.set(prefix, value);
    return;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    localeIssues.push({
      file,
      line: 1,
      message: `Expected nested string object at ${prefix || "<root>"}`,
      rule: "locale-shape"
    });
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    flattenTranslationLeaves(
      child,
      prefix ? `${prefix}.${key}` : key,
      leaves,
      file
    );
  }
}

function validateLocaleAlignment(flattenedResources) {
  const baseline = flattenedResources.get(defaultLocale);
  if (!baseline) {
    return;
  }

  for (const locale of locales.slice(1)) {
    const candidate = flattenedResources.get(locale.locale);
    if (!candidate) {
      continue;
    }

    for (const key of diffSets(baseline.keys, candidate.keys)) {
      localeIssues.push({
        file: candidate.file,
        line: 1,
        message: `Missing locale key ${key}`,
        rule: "locale-key-missing"
      });
    }

    for (const key of diffSets(candidate.keys, baseline.keys)) {
      localeIssues.push({
        file: candidate.file,
        line: 1,
        message: `Extra locale key ${key}`,
        rule: "locale-key-extra"
      });
    }

    for (const key of baseline.keys) {
      if (!candidate.keys.has(key)) {
        continue;
      }

      const baselinePlaceholders = extractPlaceholders(
        baseline.leaves.get(key)
      );
      const candidatePlaceholders = extractPlaceholders(
        candidate.leaves.get(key)
      );
      const missing = diffSets(baselinePlaceholders, candidatePlaceholders);
      const extra = diffSets(candidatePlaceholders, baselinePlaceholders);
      if (missing.length === 0 && extra.length === 0) {
        continue;
      }

      localeIssues.push({
        file: candidate.file,
        line: 1,
        message: `Placeholder mismatch for ${key}: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
        rule: "locale-placeholder"
      });
    }
  }
}

function extractPlaceholders(value) {
  const placeholders = new Set();
  for (const match of String(value ?? "").matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    placeholders.add(match[1]);
  }
  return placeholders;
}

function diffSets(left, right) {
  return Array.from(left)
    .filter((value) => !right.has(value))
    .sort();
}

async function listAllSourceFiles() {
  const files = [];
  for (const root of sourceRoots) {
    await walk(join(workspaceRoot, root), files);
  }
  return files.sort();
}

async function walk(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = toPosixPath(relative(workspaceRoot, path));

    if (entry.isDirectory()) {
      if (
        !ignoredDirectories.has(entry.name) &&
        !isIgnoredSourcePath(`${relativePath}/`)
      ) {
        await walk(path, files);
      }
      continue;
    }

    if (entry.isFile() && isTrackedSourceFile(relativePath)) {
      files.push(relativePath);
    }
  }
}

function listStagedSourceFiles() {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    {
      cwd: workspaceRoot,
      encoding: "utf8"
    }
  );

  return output
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)
    .filter(isTrackedSourceFile)
    .sort();
}

function isTrackedSourceFile(path) {
  return (
    sourceRoots.some((root) => path.startsWith(`${root}/`)) &&
    hasTextExtension(path) &&
    !isIgnoredSourcePath(path)
  );
}

function isIgnoredSourcePath(path) {
  return (
    ignoredSourceFiles.has(path) ||
    ignoredPathSegments.some((segment) => path.includes(segment)) ||
    ignoredFileSuffixes.some((suffix) => path.endsWith(suffix))
  );
}

function hasTextExtension(path) {
  return textExtensions.some((extension) => path.endsWith(extension));
}

async function inspectSourceFile(relativePath) {
  if (!existsSync(join(workspaceRoot, relativePath))) {
    return;
  }

  const content = await readFile(join(workspaceRoot, relativePath), "utf8");
  const lines = content.split(/\r?\n/);

  inspectI18nKeyUsages(relativePath, lines);
  inspectHardcodedCopy(relativePath, lines);
}

function inspectI18nKeyUsages(relativePath, lines) {
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = stripLineComment(lines[lineIndex]);

    for (const pattern of i18nCallPatterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const key = match[2] ?? match[3];
        if (!key) {
          continue;
        }

        // `t(`status.${status}`)` names a key that only exists at runtime, so
        // there is nothing static to resolve it against; the locale objects
        // still cover it through their own key-parity check.
        if (key.includes("${")) {
          continue;
        }

        if (legacyKeyPattern.test(key)) {
          keyIssues.push({
            file: relativePath,
            line: lineIndex + 1,
            message: `Legacy/generated i18n key is not allowed: ${key}`,
            rule: "i18n-key-semantic"
          });
          continue;
        }

        if (
          !validKeys.has(key) &&
          !isValidScopedKeyForFile(relativePath, key)
        ) {
          keyIssues.push({
            file: relativePath,
            line: lineIndex + 1,
            message: `Referenced i18n key does not exist: ${key}`,
            rule: "i18n-key-missing"
          });
        }
      }
    }
  }
}

function isValidScopedKeyForFile(relativePath, key) {
  for (const [
    sourceRoot,
    scopedKeys
  ] of scopedValidKeysBySourceRoot.entries()) {
    if (relativePath.startsWith(`${sourceRoot}/`) && scopedKeys.has(key)) {
      return true;
    }
  }

  return false;
}

function inspectHardcodedCopy(relativePath, lines) {
  const canContainJsx =
    relativePath.endsWith(".tsx") || relativePath.endsWith(".jsx");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = stripLineComment(lines[lineIndex]);
    if (lineHasIgnoreComment(lines, lineIndex) || isImportOrExportLine(line)) {
      continue;
    }

    if (canContainJsx) {
      inspectJsxText(relativePath, line, lineIndex + 1);
      inspectJsxAttributes(relativePath, line, lineIndex + 1);
    }
    inspectPatternMatches(
      relativePath,
      line,
      lineIndex + 1,
      uiObjectPropertyPattern,
      "hardcoded-ui-property"
    );
    inspectPatternMatches(
      relativePath,
      line,
      lineIndex + 1,
      uiCallPattern,
      "hardcoded-ui-call"
    );
    inspectPatternMatches(
      relativePath,
      line,
      lineIndex + 1,
      toastCallPattern,
      "hardcoded-toast-copy"
    );
  }
}

function inspectJsxText(relativePath, line, lineNumber) {
  if (!line.includes("</")) {
    return;
  }

  for (const match of line.matchAll(/>([^<>{}]+)</g)) {
    const text = normalizeWhitespace(match[1]);
    if (isReportableCopy(text)) {
      copyIssues.push({
        file: relativePath,
        line: lineNumber,
        message: `Hardcoded JSX text should use i18n: ${JSON.stringify(text)}`,
        rule: "hardcoded-jsx-text"
      });
    }
  }
}

function inspectJsxAttributes(relativePath, line, lineNumber) {
  for (const name of uiAttributeNames) {
    const pattern = new RegExp(`${name}=(["'])([^"']+)\\1`, "g");
    for (const match of line.matchAll(pattern)) {
      const text = normalizeWhitespace(match[2]);
      if (isReportableCopy(text)) {
        copyIssues.push({
          file: relativePath,
          line: lineNumber,
          message: `Hardcoded ${name} should use i18n: ${JSON.stringify(text)}`,
          rule: "hardcoded-ui-attribute"
        });
      }
    }
  }
}

function inspectPatternMatches(relativePath, line, lineNumber, pattern, rule) {
  pattern.lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const text = normalizeWhitespace(match[3]);
    if (isReportableCopy(text)) {
      copyIssues.push({
        file: relativePath,
        line: lineNumber,
        message: `Hardcoded user-visible copy should use i18n: ${JSON.stringify(text)}`,
        rule
      });
    }
  }
}

function stripInterpolations(value) {
  return value.replaceAll(/\$\{[^}]*\}/gu, "");
}

function isReportableCopy(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || allowedHardcodedCopy.has(normalized)) {
    return false;
  }
  // A template literal that is only placeholders plus punctuation composes a
  // value at runtime (`@${label}`); its translatable text, if any, lives at
  // whatever feeds the placeholder. Copy that still reads as prose once the
  // placeholders are removed (`Hello ${name}, welcome`) stays reportable.
  if (
    normalized.includes("${") &&
    !/\p{L}/u.test(stripInterpolations(normalized))
  ) {
    return false;
  }
  if (isLikelyCodeLikeSnippet(normalized)) {
    return false;
  }
  if (/\p{Script=Han}/u.test(normalized)) {
    return true;
  }

  const words = normalized.match(/[A-Za-z]{2,}/g) ?? [];
  if (words.length === 0) {
    return false;
  }

  return words.some(
    (word) =>
      !/^(id|url|uri|api|ipc|ui|ux|os|ok|px|em|rem|rgb|rgba|env)$/i.test(word)
  );
}

function isLikelyCodeLikeSnippet(value) {
  return (
    /^\/[A-Za-z0-9_:/.-]+$/.test(value) ||
    /^[A-Za-z0-9_.<>:-]+\/[A-Za-z0-9_.<>:/-]+$/.test(value) ||
    /^[a-z]+=[A-Za-z0-9_.:-]+$/.test(value) ||
    /^[A-Z0-9_:-]+$/.test(value)
  );
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stripLineComment(line) {
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

function lineHasIgnoreComment(lines, lineIndex) {
  return [lines[lineIndex], lines[lineIndex - 1]].some((line) =>
    line?.includes("i18n-check-ignore")
  );
}

function isImportOrExportLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("import ") || trimmed.startsWith("export type ");
}

function toPosixPath(path) {
  return path.split("\\").join("/");
}
