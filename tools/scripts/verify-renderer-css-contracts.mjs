#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { analyzeBackdropFilterArtifacts } from "./backdrop-filter-policy.mjs";

const root = resolve(process.argv[2] ?? "apps/desktop/out/renderer/assets");
const paths = await listCssFiles(root);

if (paths.length === 0) {
  throw new Error(`No renderer CSS assets found under ${root}`);
}

const assets = await Promise.all(
  paths.map(async (path) => ({ path, css: await readFile(path, "utf8") }))
);
const diagnostics = analyzeBackdropFilterArtifacts(assets);

if (diagnostics.length > 0) {
  console.error("Renderer CSS backdrop-filter contract failed:");
  for (const diagnostic of diagnostics) {
    console.error(
      `- ${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.selector ?? ""}: ${diagnostic.message}`
    );
  }
  process.exitCode = 1;
} else {
  console.log(`renderer CSS contracts passed (${paths.length} assets)`);
}

async function listCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  );
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return listCssFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".css") ? [path] : [];
    })
  );
  return nested.flat().sort();
}
