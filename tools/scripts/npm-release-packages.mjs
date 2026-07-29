import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultWorkspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
export const workspaceRoot =
  process.env.TUTTI_WORKSPACE_ROOT ?? defaultWorkspaceRoot;

export async function getNpmReleasePackages({
  packageNames: selectedNames = null
} = {}) {
  const packageMap = await discoverWorkspacePackages();
  const releasePackageNames = await readReleasePackageNames();
  validateReleasePackageSelection(packageMap, releasePackageNames);
  const selectedPackageNames = selectReleasePackageNames(
    releasePackageNames,
    selectedNames
  );

  return selectedPackageNames.map((name) => {
    const packageConfig = packageMap.get(name);

    if (!packageConfig) {
      throw new Error(
        `Release package ${name} from .changeset/config.json was not found under packages/*`
      );
    }

    if (packageConfig.manifest.private !== false) {
      throw new Error(
        `Release package ${name} must set "private": false before joining the npm release flow`
      );
    }

    if (packageConfig.manifest.publishConfig?.access !== "public") {
      throw new Error(
        `Release package ${name} must set publishConfig.access = "public"`
      );
    }

    return packageConfig;
  });
}

export function parseReleasePackageFilters(args) {
  const normalizedArgs = args.filter((arg) => arg !== "--");
  if (normalizedArgs.length === 0) {
    return null;
  }
  if (normalizedArgs.length !== 2 || normalizedArgs[0] !== "--packages-json") {
    throw new Error(
      "release package selection accepts only --packages-json <json-array>"
    );
  }

  let packageNames;
  try {
    packageNames = JSON.parse(normalizedArgs[1]);
  } catch {
    throw new Error("--packages-json must contain valid JSON");
  }
  if (
    !Array.isArray(packageNames) ||
    packageNames.length === 0 ||
    packageNames.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error("--packages-json must contain a non-empty string array");
  }
  return [...new Set(packageNames)];
}

export function selectReleasePackageNames(
  releasePackageNames,
  selectedPackageNames
) {
  if (selectedPackageNames === null) {
    return releasePackageNames;
  }

  const releaseNameSet = new Set(releasePackageNames);
  const unknownNames = selectedPackageNames.filter(
    (name) => !releaseNameSet.has(name)
  );
  if (unknownNames.length > 0) {
    throw new Error(
      `Unknown npm release package filter(s): ${unknownNames.join(", ")}`
    );
  }
  return selectedPackageNames;
}

async function readReleasePackageNames() {
  const changesetConfigText = await readFile(
    join(workspaceRoot, ".changeset/config.json"),
    "utf8"
  );
  const changesetConfig = JSON.parse(changesetConfigText);
  const fixedGroups = Array.isArray(changesetConfig.fixed)
    ? changesetConfig.fixed
    : [];
  const seen = new Set();
  const names = [];

  for (const group of fixedGroups) {
    if (!Array.isArray(group)) {
      continue;
    }

    for (const name of group) {
      if (typeof name !== "string" || seen.has(name)) {
        continue;
      }

      seen.add(name);
      names.push(name);
    }
  }

  if (names.length === 0) {
    throw new Error(
      "No npm release packages are configured in .changeset/config.json"
    );
  }

  return names;
}

export function validateReleasePackageSelection(
  packageMap,
  releasePackageNames
) {
  const releaseNameSet = new Set(releasePackageNames);
  const missingPublicPackages = [];
  const invalidRuntimeDependencies = [];

  for (const packageConfig of packageMap.values()) {
    if (
      isPublicReleaseWorkspacePackage(packageConfig.manifest) &&
      !releaseNameSet.has(packageConfig.name)
    ) {
      missingPublicPackages.push(packageConfig.name);
    }
  }

  for (const releasePackageName of releasePackageNames) {
    const packageConfig = packageMap.get(releasePackageName);

    if (!packageConfig) {
      continue;
    }

    for (const dependencyName of collectWorkspaceRuntimeDependencyNames(
      packageConfig.manifest,
      packageMap
    )) {
      if (!releaseNameSet.has(dependencyName)) {
        invalidRuntimeDependencies.push(
          `${packageConfig.name} -> ${dependencyName}`
        );
      }
    }
  }

  if (
    missingPublicPackages.length === 0 &&
    invalidRuntimeDependencies.length === 0
  ) {
    return;
  }

  const lines = [];

  if (missingPublicPackages.length > 0) {
    lines.push(
      `Public workspace packages missing from .changeset/config.json fixed release group: ${missingPublicPackages.join(", ")}`
    );
  }

  if (invalidRuntimeDependencies.length > 0) {
    lines.push(
      `Release packages must not depend on workspace runtime packages outside the fixed release group: ${invalidRuntimeDependencies.join(", ")}`
    );
  }

  throw new Error(lines.join("\n"));
}

export function isPublicReleaseWorkspacePackage(manifest) {
  return (
    manifest.private === false && manifest.publishConfig?.access === "public"
  );
}

export function collectWorkspaceRuntimeDependencyNames(manifest, packageMap) {
  const dependencyNames = new Set();

  for (const field of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies"
  ]) {
    const dependencies = manifest[field];

    if (!dependencies || typeof dependencies !== "object") {
      continue;
    }

    for (const dependencyName of Object.keys(dependencies)) {
      if (packageMap.has(dependencyName)) {
        dependencyNames.add(dependencyName);
      }
    }
  }

  return dependencyNames;
}

async function discoverWorkspacePackages() {
  const packagesRoot = join(workspaceRoot, "packages");
  const groups = await readdir(packagesRoot, { withFileTypes: true });
  const packageMap = new Map();

  for (const group of groups) {
    if (!group.isDirectory()) {
      continue;
    }

    const groupRoot = join(packagesRoot, group.name);
    const packages = await readdir(groupRoot, { withFileTypes: true });

    for (const packageEntry of packages) {
      if (!packageEntry.isDirectory()) {
        continue;
      }

      const directory = join("packages", group.name, packageEntry.name);
      const manifestPath = join(directory, "package.json");

      try {
        await access(join(workspaceRoot, manifestPath));
      } catch {
        continue;
      }

      const manifestText = await readFile(
        join(workspaceRoot, manifestPath),
        "utf8"
      );
      const manifest = JSON.parse(manifestText);

      if (typeof manifest.name !== "string") {
        continue;
      }

      packageMap.set(manifest.name, {
        directory,
        manifest,
        manifestPath,
        name: manifest.name
      });
    }
  }

  return packageMap;
}
