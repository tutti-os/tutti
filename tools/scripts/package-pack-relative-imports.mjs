import { readFile, stat } from "node:fs/promises";
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
