import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");

test("pre-commit runs the staged CSS :has() performance policy", () => {
  const hook = readFileSync(
    join(workspaceRoot, ".husky", "pre-commit"),
    "utf8"
  );

  assert.ok(hook.split("\n").includes("pnpm check:css-has-performance:staged"));
});

test("pre-push uses changed-aware push-ready validation", () => {
  const hook = readFileSync(join(workspaceRoot, ".husky", "pre-push"), "utf8");

  assert.equal(hook.trim(), "pnpm check:changed -- --push-ready");
});
