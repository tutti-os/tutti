import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parseStablePackageReleaseVersion } from "./package-release-version.mjs";

const internalModulePrefix = "github.com/tutti-os/tutti/packages/";

export async function preparePackageGoModuleReleaseTree({
  releaseVersion,
  workspaceRoot
}) {
  if (!parseStablePackageReleaseVersion(releaseVersion)) {
    throw new Error(`Unsupported package release version: ${releaseVersion}`);
  }

  const paths = await discoverPackageGoModulePaths(workspaceRoot);
  const changed = [];
  for (const relativePath of paths) {
    const path = join(workspaceRoot, relativePath);
    const original = await readFile(path, "utf8");
    const rewritten = rewriteInternalGoModuleDependencies(
      original,
      releaseVersion
    );
    if (rewritten === original) {
      continue;
    }
    await writeFile(path, rewritten);
    changed.push(relativePath);
  }
  return changed;
}

export function rewriteInternalGoModuleDependencies(text, releaseVersion) {
  if (!parseStablePackageReleaseVersion(releaseVersion)) {
    throw new Error(`Unsupported package release version: ${releaseVersion}`);
  }

  const version = `v${releaseVersion}`;
  const lines = text.replace(/\n$/, "").split("\n");
  const withoutInternalReplaces = [];
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "replace (") {
      const block = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== ")") {
        if (!isInternalReplaceBlockEntry(lines[index])) {
          block.push(lines[index]);
        } else {
          changed = true;
        }
        index += 1;
      }
      if (block.length > 0) {
        withoutInternalReplaces.push(line, ...block, lines[index]);
      }
      continue;
    }
    if (isInternalSingleLineReplace(line)) {
      changed = true;
    } else {
      withoutInternalReplaces.push(line);
    }
  }

  let inRequireBlock = false;
  const rewritten = withoutInternalReplaces.map((line) => {
    const trimmed = line.trim();
    if (trimmed === "require (") {
      inRequireBlock = true;
      return line;
    }
    if (inRequireBlock && trimmed === ")") {
      inRequireBlock = false;
      return line;
    }
    const result = rewriteInternalRequire(line, version, inRequireBlock);
    changed ||= result !== line;
    return result;
  });
  if (!changed) {
    return text;
  }
  return `${collapseBlankLines(rewritten).join("\n")}\n`;
}

function rewriteInternalRequire(line, version, inRequireBlock) {
  const blockRequire = new RegExp(
    `^(\\s*)(${escapeRegExp(internalModulePrefix)}\\S+)(\\s+)v\\S+(\\s*(?://.*)?)$`
  );
  const directRequire = new RegExp(
    `^(\\s*require\\s+)(${escapeRegExp(internalModulePrefix)}\\S+)(\\s+)v\\S+(\\s*(?://.*)?)$`
  );
  const patterns = inRequireBlock ? [blockRequire] : [directRequire];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      return `${match[1]}${match[2]}${match[3]}${version}${match[4]}`;
    }
  }
  return line;
}

function isInternalSingleLineReplace(line) {
  return new RegExp(
    `^\\s*replace\\s+${escapeRegExp(internalModulePrefix)}\\S+(?:\\s+v\\S+)?\\s+=>`
  ).test(line);
}

function isInternalReplaceBlockEntry(line) {
  return new RegExp(
    `^\\s*${escapeRegExp(internalModulePrefix)}\\S+(?:\\s+v\\S+)?\\s+=>`
  ).test(line);
}

function collapseBlankLines(lines) {
  const result = [];
  for (const line of lines) {
    if (line === "" && result.at(-1) === "") {
      continue;
    }
    result.push(line);
  }
  while (result.at(-1) === "") {
    result.pop();
  }
  return result;
}

async function discoverPackageGoModulePaths(workspaceRoot) {
  const paths = [];
  await collectGoModulePaths(
    join(workspaceRoot, "packages"),
    workspaceRoot,
    paths
  );
  return paths.sort();
}

async function collectGoModulePaths(directory, workspaceRoot, paths) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === "go.mod") {
      paths.push(toPosixPath(relative(workspaceRoot, path)));
      continue;
    }
    if (entry.isDirectory() && entry.name !== "node_modules") {
      await collectGoModulePaths(path, workspaceRoot, paths);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}
