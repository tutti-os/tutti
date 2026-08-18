import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const lockPath = resolve(
  repoRoot,
  "packages/clients/market-go/source.lock.json"
);

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

export function main(args) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const checkOnly = args.includes("--check");
  const sourceRoot = argumentValue(args, "--source-root");

  if (checkOnly && sourceRoot) {
    throw new Error("--check and --source-root cannot be used together");
  }
  if (!checkOnly && !sourceRoot) {
    throw new Error(
      "Market client sync requires --source-root pointing to a tsh-server checkout"
    );
  }
  if (sourceRoot) {
    verifySourceCheckout(sourceRoot, lock.commit);
  }

  for (const file of lock.files) {
    const targetPath = resolve(repoRoot, file.target);
    if (checkOnly) {
      if (!existsSync(targetPath)) {
        throw new Error(
          `Generated Market client file is missing: ${file.target}`
        );
      }
      const content = readFileSync(targetPath);
      verifyDigest(file, content, "generated target");
      continue;
    }

    const content = readPinnedLocalFile(sourceRoot, file.source);
    verifyDigest(file, content, "pinned source");
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
  }
}

export function verifySourceCheckout(root, expectedCommit) {
  const result = spawnSync("git", ["-C", resolve(root), "rev-parse", "HEAD"], {
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot read Market client source checkout commit: ${String(result.stderr ?? "").trim() || result.error?.message || "git rev-parse failed"}`
    );
  }
  const actualCommit = result.stdout.trim();
  if (actualCommit !== expectedCommit) {
    throw new Error(
      `Market client source checkout is at ${actualCommit}; expected ${expectedCommit}`
    );
  }
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readPinnedLocalFile(root, source) {
  const absoluteRoot = resolve(root);
  return readFileSync(resolve(absoluteRoot, source));
}

function verifyDigest(file, content, label) {
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== file.sha256) {
    throw new Error(
      `${label} ${file.source} has SHA-256 ${actual}; expected ${file.sha256}`
    );
  }
}
