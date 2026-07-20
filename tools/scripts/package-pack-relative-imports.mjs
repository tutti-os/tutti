import { readFile, readdir, stat } from "node:fs/promises";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve
} from "node:path";

const relativeImportPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)/g;
const moduleRelativeAssetPattern =
  /new URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
const javascriptExtensions = new Set([".cjs", ".js", ".mjs"]);

const extensionCandidates = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

export async function missingPackedRelativeImports(packageRoot, entryPath) {
  const normalizedRoot = resolve(packageRoot);
  const entry = resolve(normalizedRoot, entryPath);
  const pending = [entry];
  const visited = new Set();
  const missing = new Set();

  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!sourcePath || visited.has(sourcePath)) {
      continue;
    }
    visited.add(sourcePath);
    if (!(await isFile(sourcePath))) {
      missing.add(asPackagePath(normalizedRoot, sourcePath));
      continue;
    }

    const source = await readFile(sourcePath, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const importedPath = await resolveRelativeImport(sourcePath, specifier);
      if (!importedPath || !isInside(normalizedRoot, importedPath)) {
        missing.add(
          `${asPackagePath(normalizedRoot, sourcePath)} -> ${specifier}`
        );
        continue;
      }
      pending.push(importedPath);
    }
  }

  return [...missing].sort();
}

export async function missingPackedModuleRelativeAssets(packageRoot) {
  const normalizedRoot = resolve(packageRoot);
  const files = await listFiles(normalizedRoot);
  const missing = [];

  for (const file of files) {
    if (!javascriptExtensions.has(extname(file))) {
      continue;
    }

    const source = await readFile(file, "utf8");
    moduleRelativeAssetPattern.lastIndex = 0;
    for (const match of source.matchAll(moduleRelativeAssetPattern)) {
      const specifier = match[1];
      const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
      const assetPath = resolve(dirname(file), cleanSpecifier);
      if (!(await isFile(assetPath)) || !isInside(normalizedRoot, assetPath)) {
        missing.push(`${asPackagePath(normalizedRoot, file)} -> ${specifier}`);
      }
    }
  }

  return missing.sort();
}

function relativeImportSpecifiers(source) {
  const specifiers = [];
  relativeImportPattern.lastIndex = 0;
  for (const match of source.matchAll(relativeImportPattern)) {
    specifiers.push(match[1] ?? match[2]);
  }
  return specifiers;
}

async function resolveRelativeImport(sourcePath, specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const basePath = resolve(dirname(sourcePath), cleanSpecifier);
  const candidates = extname(basePath)
    ? [basePath]
    : [
        basePath,
        ...extensionCandidates.map((extension) => `${basePath}${extension}`),
        ...extensionCandidates.map((extension) =>
          join(basePath, `index${extension}`)
        )
      ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
}

function isInside(root, path) {
  const child = relative(root, path);
  return (
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

function asPackagePath(root, path) {
  return normalize(relative(root, path)).replaceAll("\\", "/");
}
