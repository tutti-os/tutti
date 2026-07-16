import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getNpmReleasePackages,
  workspaceRoot
} from "./npm-release-packages.mjs";
import { missingPackedRelativeImports } from "./package-pack-relative-imports.mjs";

const forbiddenPrefixes = [
  "package/src/",
  "package/tsconfig.json",
  "package/tsup.config"
];

// Packages that intentionally publish their raw TypeScript sources instead of a
// compiled dist/ output. @tutti-os/claude-sdk-sidecar is executed directly with
// `node --experimental-strip-types src/main.ts`, so it ships src/ on purpose.
const sourcePublishingPackages = new Set(["@tutti-os/claude-sdk-sidecar"]);

const packages = await getNpmReleasePackages();
const tempDirectory = await mkdtemp(join(tmpdir(), "tutti-pack-check-"));

try {
  for (const packageConfig of packages) {
    await checkPackage(packageConfig, tempDirectory);
  }

  console.log("package pack check passed");
} finally {
  await rm(tempDirectory, { force: true, recursive: true });
}

async function checkPackage(packageConfig, destination) {
  const packageDirectory = join(workspaceRoot, packageConfig.directory);
  const beforeFiles = new Set(await listTarballs(destination));

  execFileSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: packageDirectory,
    stdio: "inherit"
  });

  const tarball = await findNewTarball(destination, beforeFiles);
  const tarballPath = join(destination, tarball);
  const entries = listTarballEntries(tarballPath);
  const entrySet = new Set(entries);
  const violations = [];
  const requiredFiles = getRequiredFiles(packageConfig.manifest);
  const packageForbiddenPrefixes = sourcePublishingPackages.has(
    packageConfig.name
  )
    ? forbiddenPrefixes.filter((prefix) => prefix !== "package/src/")
    : forbiddenPrefixes;

  for (const requiredFile of requiredFiles) {
    if (!entrySet.has(requiredFile)) {
      violations.push(`missing ${requiredFile}`);
    }
  }

  for (const entry of entries) {
    if (packageForbiddenPrefixes.some((prefix) => entry.startsWith(prefix))) {
      violations.push(`unexpected ${entry}`);
    }
  }

  if (packageConfig.name === "@tutti-os/claude-sdk-sidecar") {
    const unpackedDirectory = join(destination, `${tarball}.unpacked`);
    await mkdir(unpackedDirectory, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", unpackedDirectory]);
    const missingImports = await missingPackedRelativeImports(
      join(unpackedDirectory, "package"),
      "src/main.ts"
    );
    for (const missingImport of missingImports) {
      violations.push(`missing runtime import ${missingImport}`);
    }
  }

  if (violations.length > 0) {
    console.error(`${packageConfig.name} pack contents are invalid:`);
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`${packageConfig.name} pack contents passed`);
}

function getRequiredFiles(manifest) {
  const requiredFiles = new Set(["package/README.md", "package/package.json"]);
  const publishConfig = manifest.publishConfig ?? {};

  if (typeof publishConfig.types === "string") {
    requiredFiles.add(asPackPath(publishConfig.types));
  }

  const exportsField = publishConfig.exports ?? manifest.exports;

  for (const exportPath of collectStringLeaves(exportsField)) {
    requiredFiles.add(asPackPath(exportPath));
  }

  return requiredFiles;
}

function collectStringLeaves(value) {
  if (typeof value === "string") {
    return [value];
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.values(value).flatMap((entry) => collectStringLeaves(entry));
}

function asPackPath(path) {
  return `package/${path.replace(/^\.\//, "")}`;
}

async function findNewTarball(directory, beforeFiles) {
  const afterFiles = await listTarballs(directory);
  const createdFiles = afterFiles.filter((file) => !beforeFiles.has(file));

  if (createdFiles.length !== 1) {
    throw new Error(
      `Expected one new package tarball, found ${createdFiles.length}`
    );
  }

  return createdFiles[0];
}

async function listTarballs(directory) {
  const files = await readdir(directory);
  return files.filter((file) => file.endsWith(".tgz"));
}

function listTarballEntries(path) {
  const output = execFileSync("tar", ["-tzf", path], {
    encoding: "utf8"
  });

  return output
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
