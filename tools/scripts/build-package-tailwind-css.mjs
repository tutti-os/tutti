import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const logPrefix = "[build-package-tailwind-css]";
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageDirectory = process.cwd();
const manifestPath = join(packageDirectory, "package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const sourceStylePath = readStyleExport(manifest.exports, "exports");
const outputStylePath = readStyleExport(
  manifest.publishConfig?.exports,
  "publishConfig.exports"
);

if (!sourceStylePath) {
  throw new Error(
    `${manifest.name} must export ./styles.css before building package Tailwind CSS`
  );
}

if (!outputStylePath) {
  throw new Error(
    `${manifest.name} must publish ./styles.css before building package Tailwind CSS`
  );
}

const sourceAbsolutePath = join(packageDirectory, sourceStylePath);
const outputAbsolutePath = join(packageDirectory, outputStylePath);
const sourceCss = await readFile(sourceAbsolutePath, "utf8");
const dependencies = new Set();
const compiler = await compile(sourceCss, {
  base: dirname(sourceAbsolutePath),
  from: sourceAbsolutePath,
  onDependency: (dependency) => dependencies.add(dependency),
  shouldRewriteUrls: true
});
const scannerSources = collectScannerSources(compiler);
const scanner = new Scanner({ sources: scannerSources });
const candidates = scanner.scan();
const builtCss = compiler.build(candidates);
const optimizedCss = optimize(builtCss, { minify: false }).code;

await mkdir(dirname(outputAbsolutePath), { recursive: true });
await writeFile(outputAbsolutePath, optimizedCss);

console.log(
  `${logPrefix} ${JSON.stringify({
    package: manifest.name,
    source: relative(workspaceRoot, sourceAbsolutePath),
    output: relative(workspaceRoot, outputAbsolutePath),
    scannerSources: scannerSources.length,
    candidates: candidates.length,
    dependencies: dependencies.size
  })}`
);

function readStyleExport(exportsField, fieldName) {
  const value = exportsField?.["./styles.css"];

  if (typeof value === "string") {
    return normalizePackagePath(value);
  }

  if (value && typeof value === "object" && typeof value.default === "string") {
    return normalizePackagePath(value.default);
  }

  if (value && typeof value === "object" && typeof value.import === "string") {
    return normalizePackagePath(value.import);
  }

  if (exportsField) {
    throw new Error(`Unsupported ${fieldName}["./styles.css"] shape`);
  }

  return null;
}

function normalizePackagePath(path) {
  return path.replace(/^\.\//, "");
}

function collectScannerSources(compiler) {
  const rootSources =
    compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base: packageDirectory, pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }];

  return rootSources.concat(compiler.sources);
}
