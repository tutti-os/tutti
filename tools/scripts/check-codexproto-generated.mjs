import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const codexRepoUrl = "https://github.com/openai/codex.git";
const codexSourceCommit = "6d2168f06ae275d5e1f73cabf935d2bcc8549998";
const schemaSubdir = "codex-rs/app-server-protocol/schema/json";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const daemonRoot = join(workspaceRoot, "packages", "agent", "daemon");
const codexprotoRoot = join(daemonRoot, "runtime", "codexproto");
const vendoredSchemaRoot = join(codexprotoRoot, "schema", "json");

// The upstream re-fetch against the pinned Codex commit is CI's job
// (ADR 0002): local check:full runs must not block on cloning
// github.com/openai/codex (and must work offline). Pass --upstream to
// opt in locally.
if (process.env.CI || process.argv.includes("--upstream")) {
  compareVendoredSchemaAgainstUpstream();
} else {
  console.log(
    "skipping upstream codex schema comparison (CI-only; pass --upstream to run locally)"
  );
}

run("go", ["run", "./runtime/codexproto/internal/codegen"], daemonRoot);
run(
  "git",
  ["diff", "--exit-code", "--", "packages/agent/daemon/runtime/codexproto"],
  workspaceRoot
);
assertNoUntrackedGeneratedFiles();

console.log("codexproto generated artifacts are current");

function compareVendoredSchemaAgainstUpstream() {
  const tempRoot = mkdtempSync(join(tmpdir(), "tutti-codexproto-"));
  try {
    const upstreamRoot = join(tempRoot, "codex");
    run("git", ["init", upstreamRoot], workspaceRoot);
    run(
      "git",
      ["-C", upstreamRoot, "remote", "add", "origin", codexRepoUrl],
      workspaceRoot
    );
    run(
      "git",
      ["-C", upstreamRoot, "fetch", "--depth=1", "origin", codexSourceCommit],
      workspaceRoot
    );
    run(
      "git",
      ["-C", upstreamRoot, "checkout", "FETCH_HEAD", "--", schemaSubdir],
      workspaceRoot
    );

    compareDirectories(join(upstreamRoot, schemaSubdir), vendoredSchemaRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function compareDirectories(expectedRoot, actualRoot) {
  const expected = fileHashes(expectedRoot);
  const actual = fileHashes(actualRoot);
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  const mismatches = [];

  for (const path of [...paths].sort()) {
    if (!expected.has(path)) {
      mismatches.push(`unexpected vendored schema: ${path}`);
      continue;
    }
    if (!actual.has(path)) {
      mismatches.push(`missing vendored schema: ${path}`);
      continue;
    }
    if (expected.get(path) !== actual.get(path)) {
      mismatches.push(`vendored schema differs: ${path}`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      [
        "codexproto schema drift detected against pinned Codex commit",
        ...mismatches.map((line) => `- ${line}`)
      ].join("\n")
    );
  }
}

// `git diff --exit-code` ignores untracked files, so codegen creating a
// brand-new artifact (e.g. a fresh *_gen.go) would otherwise pass the check
// while the file is uncommitted.
function assertNoUntrackedGeneratedFiles() {
  const result = spawnSync(
    "git",
    ["status", "--porcelain", "--", "packages/agent/daemon/runtime/codexproto"],
    { cwd: workspaceRoot, encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error("git status for codexproto failed");
  }
  const untracked = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("??"));
  if (untracked.length > 0) {
    throw new Error(
      [
        "codexproto codegen produced untracked files (invisible to git diff); commit them:",
        ...untracked.map((line) => `- ${line.slice(3)}`)
      ].join("\n")
    );
  }
}

function fileHashes(root) {
  const out = new Map();
  for (const path of walkFiles(root)) {
    const rel = relative(root, path);
    const content = rel.endsWith(".json")
      ? canonicalJson(readFileSync(path, "utf8"))
      : readFileSync(path);
    const hash = createHash("sha256").update(content).digest("hex");
    out.set(rel, hash);
  }
  return out;
}

function canonicalJson(source) {
  return JSON.stringify(sortJsonValue(JSON.parse(source)));
}

function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }
  return value;
}

function walkFiles(root) {
  const out = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...walkFiles(path));
    } else if (stat.isFile()) {
      out.push(path);
    }
  }
  return out;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}
