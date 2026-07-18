import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");

test("pre-push uses changed-aware push-ready validation", () => {
  const hook = readFileSync(join(workspaceRoot, ".husky", "pre-push"), "utf8");

  assert.equal(hook.trim(), "pnpm check:changed -- --push-ready");
});
