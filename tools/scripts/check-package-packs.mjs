import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getNpmReleasePackages,
  workspaceRoot
} from "./npm-release-packages.mjs";

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
  const entries = listTarballEntries(join(destination, tarball));
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

  if (violations.length > 0) {
    console.error(`${packageConfig.name} pack contents are invalid:`);
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  if (packageConfig.name === "@tutti-os/workspace-external-core") {
    await checkWorkspaceExternalCoreImports(
      join(destination, tarball),
      destination
    );
  }

  console.log(`${packageConfig.name} pack contents passed`);
}

async function checkWorkspaceExternalCoreImports(tarballPath, destination) {
  const fixtureDirectory = await mkdtemp(
    join(destination, "workspace-external-core-fixture-")
  );
  const packageDirectory = join(
    fixtureDirectory,
    "node_modules",
    "@tutti-os",
    "workspace-external-core"
  );
  await mkdir(packageDirectory, { recursive: true });

  try {
    execFileSync(
      "tar",
      ["-xzf", tarballPath, "-C", packageDirectory, "--strip-components=1"],
      { stdio: "inherit" }
    );
    const verifierPath = join(fixtureDirectory, "verify-imports.mjs");
    await writeFile(
      verifierPath,
      [
        'import assert from "node:assert/strict";',
        'import { tuttiExternalAtProviderIds as rootAtProviders } from "@tutti-os/workspace-external-core";',
        'import { tuttiExternalOperations } from "@tutti-os/workspace-external-core/contracts";',
        'import { normalizeTuttiExternalAtQueryInput } from "@tutti-os/workspace-external-core/core";',
        'import { createTuttiExternalBridge } from "@tutti-os/workspace-external-core/host";',
        'import { createTuttiExternalConformanceController, tuttiExternalStable26ConformanceCases, tuttiExternalStable26ConformanceProfile } from "@tutti-os/workspace-external-core/host/conformance";',
        'import { createTuttiExternalAtRichTextTriggerProviders } from "@tutti-os/workspace-external-core/rich-text";',
        "assert.equal(rootAtProviders.length, 6);",
        "assert.equal(tuttiExternalOperations.length, 26);",
        'assert.equal(typeof normalizeTuttiExternalAtQueryInput, "function");',
        'assert.equal(typeof createTuttiExternalBridge, "function");',
        'assert.equal(typeof createTuttiExternalConformanceController, "function");',
        'assert.equal(tuttiExternalStable26ConformanceProfile.id, "stable26");',
        "assert.equal(tuttiExternalStable26ConformanceProfile.capabilities.operations.length, 26);",
        "assert.equal(tuttiExternalStable26ConformanceCases.length, 8);",
        'assert.equal(typeof createTuttiExternalAtRichTextTriggerProviders, "function");',
        ""
      ].join("\n"),
      "utf8"
    );
    execFileSync(process.execPath, [verifierPath], {
      cwd: fixtureDirectory,
      stdio: "inherit"
    });

    const typeVerifierPath = join(fixtureDirectory, "verify-imports.ts");
    await writeFile(
      typeVerifierPath,
      [
        'import { tuttiExternalStable26ConformanceProfile, type TuttiExternalConformanceCase, type TuttiExternalConformanceController, type TuttiExternalStable26ConformanceProfile } from "@tutti-os/workspace-external-core/host/conformance";',
        "declare const conformanceCase: TuttiExternalConformanceCase;",
        "declare const controller: TuttiExternalConformanceController;",
        "const exactProfile: TuttiExternalStable26ConformanceProfile = controller.profile;",
        'const firstOperation: "app.getContext" = exactProfile.capabilities.operations[0];',
        "// @ts-expect-error public conformance cases are immutable.",
        "conformanceCase.run = async () => undefined;",
        "// @ts-expect-error every stable26 capability roster is required.",
        'const missingRoster: TuttiExternalStable26ConformanceProfile["capabilities"] = {',
        "  operations: tuttiExternalStable26ConformanceProfile.capabilities.operations,",
        "  atProviders: tuttiExternalStable26ConformanceProfile.capabilities.atProviders,",
        "  workspaceFeatures: tuttiExternalStable26ConformanceProfile.capabilities.workspaceFeatures,",
        "  workspaceAgentProviders: tuttiExternalStable26ConformanceProfile.capabilities.workspaceAgentProviders",
        "};",
        "void conformanceCase;",
        "void firstOperation;",
        "void missingRoster;",
        ""
      ].join("\n"),
      "utf8"
    );
    execFileSync(
      "pnpm",
      [
        "exec",
        "tsgo",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        typeVerifierPath
      ],
      { cwd: workspaceRoot, stdio: "inherit" }
    );
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
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
