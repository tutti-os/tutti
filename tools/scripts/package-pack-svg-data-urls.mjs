import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const javascriptExtensions = new Set([".cjs", ".js", ".mjs"]);
const rawSvgDataUrlPattern =
  /data:image\/svg\+xml(?:;charset=[^,]+)?,\s*\x3csvg\b/i;
const relativeSvgUrlPattern = /["']\.\/[^"']+\.svg["']/gi;

export async function packedFilesWithRawSvgDataUrls(packageRoot) {
  const normalizedRoot = resolve(packageRoot);
  const files = await listFiles(normalizedRoot);
  const violations = [];

  for (const file of files) {
    if (!javascriptExtensions.has(extname(file))) {
      continue;
    }

    const source = await readFile(file, "utf8");
    if (rawSvgDataUrlPattern.test(source)) {
      violations.push(relative(normalizedRoot, file).replaceAll("\\", "/"));
    }
  }

  return violations.sort();
}

export async function packedFilesWithRelativeSvgUrls(packageRoot) {
  const normalizedRoot = resolve(packageRoot);
  const files = await listFiles(normalizedRoot);
  const violations = [];

  for (const file of files) {
    if (!javascriptExtensions.has(extname(file))) {
      continue;
    }

    const source = await readFile(file, "utf8");
    if (hasConsumerUnresolvableRelativeSvgUrl(source)) {
      violations.push(relative(normalizedRoot, file).replaceAll("\\", "/"));
    }
  }

  return violations.sort();
}

function hasConsumerUnresolvableRelativeSvgUrl(source) {
  for (const match of source.matchAll(relativeSvgUrlPattern)) {
    const prefix = source.slice(Math.max(0, match.index - 32), match.index);
    if (!/new URL\(\s*$/.test(prefix)) {
      return true;
    }
  }
  return false;
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
