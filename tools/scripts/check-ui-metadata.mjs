import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowedCategories = new Set([
  "primitive",
  "composition",
  "icon",
  "style-entry",
  "utility"
]);
const allowedStatuses = new Set(["experimental", "stable", "deprecated"]);
const allowedLayers = new Set(["base", "business"]);
const allowedIconVariants = new Set(["lined", "filled"]);
const allowedTopLevelKeys = new Set(["$schema", "schemaVersion", "components"]);
const allowedComponentKeys = new Set([
  "id",
  "layer",
  "name",
  "export",
  "from",
  "category",
  "status",
  "source",
  "iconVariant",
  "propsType",
  "description",
  "useCases",
  "migrationHints",
  "nativePreview",
  "storyboard"
]);
const publicEntrypoints = new Map([
  ["@tutti-os/ui-system", "src/index.ts"],
  ["@tutti-os/ui-system/components", "src/components/index.ts"],
  ["@tutti-os/ui-system/icons", "src/icons/index.ts"],
  ["@tutti-os/ui-system/metadata", "src/metadata/index.ts"],
  ["@tutti-os/ui-system/native", "src/native/index.ts"],
  ["@tutti-os/ui-system/native.css", "src/styles/native.css"],
  ["@tutti-os/ui-system/styles.css", "src/styles/index.css"],
  ["@tutti-os/ui-system/utils", "src/lib/utils.ts"]
]);
const metadataCoveredEntrypoints = new Set([
  "@tutti-os/ui-system/components",
  "@tutti-os/ui-system/icons"
]);

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
const packageRoot = path.join(repoRoot, "packages/ui/system");
const metadataPath = path.join(packageRoot, "src/metadata/components.json");
const packageJsonPath = path.join(packageRoot, "package.json");
const nativeGalleryPath = path.join(
  repoRoot,
  "apps/mobile/src/dev/NativeComponentGallery.tsx"
);
const nativeGallerySource = existsSync(nativeGalleryPath)
  ? readFileSync(nativeGalleryPath, "utf8")
  : "";

const violations = [];

function addViolation(message) {
  violations.push(message);
}

function formatComponent(component, index) {
  if (component && typeof component.name === "string") {
    return `${component.name} at metadata.components[${index}]`;
  }

  return `metadata.components[${index}]`;
}

function readPackageFile(relativePath) {
  return readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function moduleSpecifierForSource(barrelPath, source) {
  const parsed = path.parse(source);
  const barrelDir = path.dirname(barrelPath);
  const sourcePathWithoutExtension =
    parsed.name === "index"
      ? path.relative(barrelDir, parsed.dir)
      : path.join(path.relative(barrelDir, parsed.dir), parsed.name);
  return `./${sourcePathWithoutExtension}`;
}

function exportedValueNames(sourceText) {
  const names = new Set();
  const directExportPattern =
    /export\s+(?:declare\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/g;
  const namedExportPattern = /export\s*\{([^}]+)\}/g;

  for (const match of sourceText.matchAll(directExportPattern)) {
    names.add(match[1]);
  }

  for (const match of sourceText.matchAll(namedExportPattern)) {
    for (const rawName of match[1].split(",")) {
      const name = exportedNameFromSpecifier(rawName);

      if (name) {
        names.add(name);
      }
    }
  }

  return names;
}

function exportedNameFromSpecifier(rawName) {
  const trimmed = rawName.trim();

  if (trimmed.length === 0 || trimmed.startsWith("type ")) {
    return null;
  }

  const aliasMatch = trimmed.match(
    /^[A-Za-z_$][\w$]*\s+as\s+([A-Za-z_$][\w$]*)$/u
  );

  if (aliasMatch) {
    return aliasMatch[1];
  }

  return trimmed;
}

function barrelExportsSource(barrelPath, barrelText, source) {
  const specifier = moduleSpecifierForSource(barrelPath, source);
  const normalizedSpecifier = specifier.replaceAll(path.sep, "/");
  const escapedSpecifier = normalizedSpecifier.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const exportAllPattern = new RegExp(
    `export\\s+\\*\\s+from\\s+["']${escapedSpecifier}["']`
  );
  const namedFromPattern = new RegExp(
    `export\\s*\\{[^}]+\\}\\s*from\\s+["']${escapedSpecifier}["']`
  );

  return exportAllPattern.test(barrelText) || namedFromPattern.test(barrelText);
}

function publicValueExports(barrelPath) {
  const barrelText = readPackageFile(barrelPath);
  const names = exportedValueNames(barrelText);
  const exportAllPattern = /export\s+\*\s+from\s+["']([^"']+)["']/g;

  for (const match of barrelText.matchAll(exportAllPattern)) {
    const sourcePath = resolveBarrelSpecifier(barrelPath, match[1]);

    if (!sourcePath) {
      addViolation(
        `${barrelPath} re-exports "${match[1]}", but that source could not be resolved`
      );
      continue;
    }

    for (const name of exportedValueNames(readPackageFile(sourcePath))) {
      names.add(name);
    }
  }

  return names;
}

function resolveBarrelSpecifier(barrelPath, specifier) {
  const basePath = path.normalize(
    path.join(path.dirname(barrelPath), specifier)
  );
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mts`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx")
  ];

  for (const candidate of candidates) {
    const absoluteCandidate = path.join(packageRoot, candidate);
    const relativeCandidate = path.relative(packageRoot, absoluteCandidate);

    if (
      relativeCandidate.startsWith("..") ||
      path.isAbsolute(relativeCandidate)
    ) {
      continue;
    }

    if (existsSync(absoluteCandidate) && statSync(absoluteCandidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function validatePublicExportCoverage(metadataExports) {
  for (const entrypoint of metadataCoveredEntrypoints) {
    const barrelPath = publicEntrypoints.get(entrypoint);

    if (!barrelPath || !existsSync(path.join(packageRoot, barrelPath))) {
      addViolation(
        `${entrypoint} does not point to an existing public barrel for metadata coverage`
      );
      continue;
    }

    for (const exportName of publicValueExports(barrelPath)) {
      if (metadataExports.has(`${entrypoint}:${exportName}`)) {
        continue;
      }

      addViolation(
        `${entrypoint} export "${exportName}" is missing UI-system metadata`
      );
    }
  }
}

let packageJson;
let metadata;

try {
  packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
} catch (error) {
  addViolation(
    `Unable to read or parse packages/ui/system/package.json: ${error.message}`
  );
}

try {
  metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
} catch (error) {
  addViolation(
    `Unable to read or parse packages/ui/system/src/metadata/components.json: ${error.message}`
  );
}

if (metadata !== undefined) {
  if (
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata === null
  ) {
    addViolation("metadata must be an object");
  } else {
    for (const key of Object.keys(metadata)) {
      if (!allowedTopLevelKeys.has(key)) {
        addViolation(`metadata has unexpected top-level key "${key}"`);
      }
    }

    if (
      !Number.isInteger(metadata.schemaVersion) ||
      metadata.schemaVersion < 1
    ) {
      addViolation("metadata.schemaVersion must be a positive integer");
    }
  }

  if (!Array.isArray(metadata?.components)) {
    addViolation("metadata.components must be an array");
  } else {
    const names = new Map();
    const ids = new Map();
    const exports = new Map();
    const metadataExports = new Set();

    metadata.components.forEach((component, index) => {
      const label = formatComponent(component, index);

      if (
        !component ||
        typeof component !== "object" ||
        Array.isArray(component)
      ) {
        addViolation(`${label} must be an object`);
        return;
      }

      for (const key of Object.keys(component)) {
        if (!allowedComponentKeys.has(key)) {
          addViolation(`${label} has unexpected key "${key}"`);
        }
      }

      if (typeof component.id !== "string" || component.id.length === 0) {
        addViolation(`${label} must have a non-empty string id`);
      } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(component.id)) {
        addViolation(
          `${label} id "${component.id}" must use readable kebab-case`
        );
      } else if (ids.has(component.id)) {
        addViolation(
          `${label} duplicates id "${component.id}" from metadata.components[${ids.get(
            component.id
          )}]`
        );
      } else {
        ids.set(component.id, index);
      }

      if (!allowedLayers.has(component.layer)) {
        addViolation(
          `${label} has invalid layer "${component.layer}"; allowed layers are ${[
            ...allowedLayers
          ].join(", ")}`
        );
      }

      if (typeof component.name !== "string" || component.name.length === 0) {
        addViolation(`${label} must have a non-empty string name`);
      } else if (names.has(component.name)) {
        addViolation(
          `${label} duplicates name "${component.name}" from metadata.components[${names.get(
            component.name
          )}]`
        );
      } else {
        names.set(component.name, index);
      }

      if (
        typeof component.export !== "string" ||
        component.export.length === 0
      ) {
        addViolation(`${label} must have a non-empty string export`);
      } else if (exports.has(component.export)) {
        addViolation(
          `${label} duplicates export "${component.export}" from metadata.components[${exports.get(
            component.export
          )}]`
        );
      } else {
        exports.set(component.export, index);
      }

      if (
        typeof component.from === "string" &&
        typeof component.export === "string" &&
        component.from.length > 0 &&
        component.export.length > 0
      ) {
        metadataExports.add(`${component.from}:${component.export}`);
      }

      if (
        typeof component.name === "string" &&
        typeof component.export === "string" &&
        component.name !== component.export
      ) {
        addViolation(
          `${label} name must match export "${component.export}", got "${component.name}"`
        );
      }

      if (!publicEntrypoints.has(component.from)) {
        addViolation(
          `${label} has invalid from "${component.from}"; allowed entrypoints are ${[
            ...publicEntrypoints.keys()
          ].join(", ")}`
        );
      } else if (packageJson?.exports) {
        const packageExport =
          component.from === "@tutti-os/ui-system"
            ? "."
            : `.${component.from.replace("@tutti-os/ui-system", "")}`;

        if (!packageJson.exports[packageExport]) {
          addViolation(
            `${label} from "${component.from}" is not exposed in package.json exports`
          );
        }
      }

      if (!allowedCategories.has(component.category)) {
        addViolation(
          `${label} has invalid category "${component.category}"; allowed categories are ${[
            ...allowedCategories
          ].join(", ")}`
        );
      }

      if (component.iconVariant !== undefined) {
        if (component.category !== "icon") {
          addViolation(`${label} iconVariant is only valid for icon metadata`);
        } else if (!allowedIconVariants.has(component.iconVariant)) {
          addViolation(
            `${label} has invalid iconVariant "${component.iconVariant}"; allowed variants are ${[
              ...allowedIconVariants
            ].join(", ")}`
          );
        }
      }

      if (!allowedStatuses.has(component.status)) {
        addViolation(
          `${label} has invalid status "${component.status}"; allowed statuses are ${[
            ...allowedStatuses
          ].join(", ")}`
        );
      }

      if (typeof component.source !== "string") {
        addViolation(`${label} source must be a string`);
      } else if (!component.source.startsWith("src/")) {
        addViolation(`${label} source must start with "src/"`);
      } else {
        const resolvedSource = path.resolve(packageRoot, component.source);
        const relativeSource = path.relative(packageRoot, resolvedSource);

        if (
          relativeSource.startsWith("..") ||
          path.isAbsolute(relativeSource)
        ) {
          addViolation(`${label} source must stay under packages/ui/system`);
        } else if (!existsSync(resolvedSource)) {
          addViolation(
            `${label} source file does not exist: ${component.source}`
          );
        } else if (component.category !== "style-entry") {
          const sourceExports = publicValueExports(component.source);

          if (!sourceExports.has(component.export)) {
            addViolation(
              `${label} export "${component.export}" was not found in ${component.source}`
            );
          }
        }
      }

      if (
        typeof component.description !== "string" ||
        component.description.trim().length === 0
      ) {
        addViolation(`${label} description must be a non-empty string`);
      }

      if (!Array.isArray(component.useCases)) {
        addViolation(`${label} useCases must be an array`);
      } else {
        component.useCases.forEach((useCase, useCaseIndex) => {
          if (typeof useCase !== "string") {
            addViolation(`${label} useCases[${useCaseIndex}] must be a string`);
          }
        });
      }

      if (!Array.isArray(component.migrationHints)) {
        addViolation(`${label} migrationHints must be an array`);
      } else {
        component.migrationHints.forEach((migrationHint, hintIndex) => {
          if (typeof migrationHint !== "string") {
            addViolation(
              `${label} migrationHints[${hintIndex}] must be a string`
            );
          }
        });
      }

      if (
        component.storyboard !== undefined &&
        typeof component.storyboard !== "boolean"
      ) {
        addViolation(`${label} storyboard must be boolean when present`);
      }

      if (
        component.nativePreview !== undefined &&
        typeof component.nativePreview !== "boolean"
      ) {
        addViolation(`${label} nativePreview must be boolean when present`);
      } else if (component.nativePreview === true) {
        if (component.from !== "@tutti-os/ui-system/native") {
          addViolation(
            `${label} nativePreview requires the @tutti-os/ui-system/native entrypoint`
          );
        }

        if (!nativeGallerySource.includes(`title="${component.id}"`)) {
          addViolation(
            `${label} nativePreview requires a matching Mobile development gallery section`
          );
        }
      }

      if (
        publicEntrypoints.has(component.from) &&
        component.category !== "style-entry" &&
        typeof component.source === "string" &&
        component.source.startsWith("src/")
      ) {
        const barrelPath = publicEntrypoints.get(component.from);
        const sourcePath = path.normalize(component.source);

        if (path.normalize(barrelPath) === sourcePath) {
          return;
        }

        if (!barrelPath || !existsSync(path.join(packageRoot, barrelPath))) {
          addViolation(
            `${label} from "${component.from}" does not point to an existing public barrel`
          );
          return;
        }

        const barrelText = readPackageFile(barrelPath);

        if (!barrelExportsSource(barrelPath, barrelText, sourcePath)) {
          addViolation(
            `${label} source "${component.source}" is not re-exported by ${component.from}`
          );
        }
      }
    });

    validatePublicExportCoverage(metadataExports);
  }
}

if (violations.length > 0) {
  console.error("ui metadata check failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("ui metadata check passed");
