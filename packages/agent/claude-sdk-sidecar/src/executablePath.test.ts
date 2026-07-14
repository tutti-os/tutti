import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  nativeSdkBinaryAvailable,
  resolveClaudeCodeExecutablePath
} from "./executablePath.ts";

function fakeExecutable(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-exec-test-"));
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
  return path;
}

test("explicit CLAUDE_CODE_EXECUTABLE always wins", () => {
  const resolved = resolveClaudeCodeExecutablePath(
    {
      CLAUDE_CODE_EXECUTABLE: "/custom/claude",
      TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE: fakeExecutable("claude")
    },
    () => true
  );
  assert.equal(resolved, "/custom/claude");
});

test("no override when the SDK resolves its own native binary", () => {
  const resolved = resolveClaudeCodeExecutablePath(
    { TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE: fakeExecutable("claude") },
    () => true
  );
  assert.equal(resolved, undefined);
});

test("fallback executable used when SDK cannot self-resolve", () => {
  const fallback = fakeExecutable("claude");
  const resolved = resolveClaudeCodeExecutablePath(
    { TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE: fallback },
    () => false
  );
  assert.equal(resolved, fallback);
});

test("missing fallback file is ignored", () => {
  const resolved = resolveClaudeCodeExecutablePath(
    { TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE: "/nonexistent/claude" },
    () => false
  );
  assert.equal(resolved, undefined);
});

test("blank env values are ignored", () => {
  const resolved = resolveClaudeCodeExecutablePath(
    {
      CLAUDE_CODE_EXECUTABLE: "   ",
      TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE: ""
    },
    () => false
  );
  assert.equal(resolved, undefined);
});

test("nativeSdkBinaryAvailable reflects the installed dev tree", () => {
  // In the pnpm workspace the platform package for the current platform is
  // installed next to the SDK, so self-resolution must succeed here — this is
  // exactly the property that keeps dev sessions on the pinned binary.
  assert.equal(nativeSdkBinaryAvailable(), true);
});
