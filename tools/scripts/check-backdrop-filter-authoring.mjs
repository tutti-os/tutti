#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeBackdropFilterAuthoring,
  isBackdropFilterAuthoringPath
} from "./backdrop-filter-policy.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "../..");
const staged = process.argv.includes("--staged");
const files = listFiles();
const diagnostics = files.flatMap((path) =>
  analyzeBackdropFilterAuthoring({ path, source: readSource(path) })
);

if (diagnostics.length > 0) {
  console.error(
    "Handwritten -webkit-backdrop-filter is forbidden in production stylesheet authoring."
  );
  for (const diagnostic of diagnostics) {
    console.error(
      `- ${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.token}: ${diagnostic.message}`
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `backdrop-filter authoring policy passed (${files.length} ${staged ? "staged " : ""}files)`
  );
}

function listFiles() {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  return execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .filter(isBackdropFilterAuthoringPath)
    .filter((path) => staged || existsSync(join(workspaceRoot, path)));
}

function readSource(path) {
  if (staged) {
    return execFileSync("git", ["show", `:${path}`], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024
    });
  }
  return readFileSync(join(workspaceRoot, path), "utf8");
}
