import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(scriptDirectory, "check-tutti-names.mjs");
const workspaceRoot = resolve(scriptDirectory, "..", "..");

test("allows legacy OAuth app id compatibility constants", () => {
  const result = spawnSync("node", [scriptPath], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
});

test("rejects legacy product tokens in file paths", async () => {
  const forbiddenPathSegment = ["n", "e", "x", "t", "o", "p"].join("");
  const fixtureDir = join(
    workspaceRoot,
    `.tmp-tutti-name-check-${Date.now()}-${forbiddenPathSegment}`
  );
  const fixturePath = join(fixtureDir, "clean.txt");

  try {
    await mkdir(fixtureDir, { recursive: true });
    await writeFile(fixturePath, "clean content\n", "utf8");

    const result = spawnSync("node", [scriptPath], {
      cwd: workspaceRoot,
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unexpected legacy product tokens found/);
    assert.match(result.stderr, /clean\.txt/);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
