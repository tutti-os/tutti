import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getNpmReleasePackages,
  workspaceRoot
} from "./npm-release-packages.mjs";
import {
  missingPackedModuleRelativeAssets,
  missingPackedRelativeImports
} from "./package-pack-relative-imports.mjs";
import {
  packedFilesWithRawSvgDataUrls,
  packedFilesWithRelativeSvgUrls
} from "./package-pack-svg-data-urls.mjs";
import {
  externalBundledTiptapImports,
  packagePeerContractViolations
} from "./package-pack-peer-contracts.mjs";

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
  violations.push(
    ...packagePeerContractViolations(packageConfig.name, packageConfig.manifest)
  );
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

  if (packageConfig.name === "@tutti-os/agent-gui") {
    const unpackedDirectory = join(destination, `${tarball}.unpacked`);
    await mkdir(unpackedDirectory, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", unpackedDirectory]);
    const rawSvgDataUrlFiles = await packedFilesWithRawSvgDataUrls(
      join(unpackedDirectory, "package")
    );
    for (const file of rawSvgDataUrlFiles) {
      violations.push(`raw SVG data URL in ${file}`);
    }
    const relativeSvgUrlFiles = await packedFilesWithRelativeSvgUrls(
      join(unpackedDirectory, "package")
    );
    for (const file of relativeSvgUrlFiles) {
      violations.push(`consumer-unresolvable relative SVG URL in ${file}`);
    }
  }

  if (packageConfig.name === "@tutti-os/ui-rich-text") {
    const unpackedDirectory = join(destination, `${tarball}.unpacked`);
    await mkdir(unpackedDirectory, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", unpackedDirectory]);
    const editorSource = await readFile(
      join(unpackedDirectory, "package/dist/editor/index.js"),
      "utf8"
    );
    for (const specifier of externalBundledTiptapImports(
      packageConfig.name,
      editorSource
    )) {
      violations.push(`unbundled internal Tiptap extension ${specifier}`);
    }
  }

  if (packageConfig.name === "@tutti-os/workspace-file-manager") {
    const unpackedDirectory = join(destination, `${tarball}.unpacked`);
    await mkdir(unpackedDirectory, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", unpackedDirectory]);
    const packageRoot = join(unpackedDirectory, "package");
    const missingAssets = await missingPackedModuleRelativeAssets(packageRoot);
    for (const missingAsset of missingAssets) {
      violations.push(`missing module-relative asset ${missingAsset}`);
    }
    const mainEntrySource = await readFile(
      join(packageRoot, "dist/index.js"),
      "utf8"
    );
    if (/data:image\/png(?:;|,)/i.test(mainEntrySource)) {
      violations.push("PNG data URL embedded in dist/index.js");
    }
    if (
      /new URL\(\s*["']\.\/assets\/workspace-(?:archive|folder)-fallback\.png["']/u.test(
        mainEntrySource
      )
    ) {
      violations.push(
        "fallback asset URL is relative to the bundled module location"
      );
    }
    if (
      /@tutti-os\/workspace-file-manager\/assets\/workspace-(?:archive|folder)-fallback\.png/u.test(
        mainEntrySource
      )
    ) {
      violations.push(
        "main runtime imports a fallback image instead of a code-owned UI icon"
      );
    }
    try {
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
            for (const fallbackKind of ["archive", "folder"]) {
              const { default: assetUrl } = await import(
                \`@tutti-os/workspace-file-manager/assets/workspace-\${fallbackKind}-fallback.png\`
              );
              if (
                !assetUrl.startsWith("file:") ||
                !assetUrl.endsWith(\`workspace-\${fallbackKind}-fallback.png\`)
              ) {
                throw new Error(\`unexpected \${fallbackKind} fallback URL: \${assetUrl}\`);
              }
            }
          `
        ],
        {
          cwd: packageRoot,
          stdio: "pipe"
        }
      );
    } catch (error) {
      const detail =
        error instanceof Error && "stderr" in error
          ? String(error.stderr).trim()
          : String(error);
      violations.push(`Node fallback asset import failed: ${detail}`);
    }
  }

  if (packageConfig.name === "@tutti-os/commerce") {
    const unpackedDirectory = join(destination, `${tarball}.unpacked`);
    await mkdir(unpackedDirectory, { recursive: true });
    execFileSync("tar", ["-xzf", tarballPath, "-C", unpackedDirectory]);
    const packageRoot = join(unpackedDirectory, "package");
    const missingAssets = await missingPackedModuleRelativeAssets(packageRoot);
    for (const missingAsset of missingAssets) {
      violations.push(`missing module-relative asset ${missingAsset}`);
    }
    try {
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
            for (const asset of [
              "star-free.png",
              "star-lite.png",
              "star-pro.png",
              "star-ultra.png",
              "registration-credits-bg.png"
            ]) {
              const { default: assetUrl } = await import(
                \`@tutti-os/commerce/assets/\${asset}\`
              );
              if (!assetUrl.startsWith("file:") || !assetUrl.endsWith(asset)) {
                throw new Error(\`unexpected Commerce asset URL: \${assetUrl}\`);
              }
            }
          `
        ],
        {
          cwd: packageRoot,
          stdio: "pipe"
        }
      );
    } catch (error) {
      const detail =
        error instanceof Error && "stderr" in error
          ? String(error.stderr).trim()
          : String(error);
      violations.push(`Node Commerce asset import failed: ${detail}`);
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
