import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { verifySourceCheckout } from "./sync-market-go-client.mjs";

test("Market client sync requires the pinned provider commit", (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "tutti-market-source-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", checkout]);
  execFileSync(
    "git",
    [
      "-C",
      checkout,
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "provider fixture"
    ],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: "market-client-test@example.invalid",
        GIT_AUTHOR_NAME: "Market Client Test",
        GIT_COMMITTER_EMAIL: "market-client-test@example.invalid",
        GIT_COMMITTER_NAME: "Market Client Test"
      }
    }
  );
  const actualCommit = execFileSync(
    "git",
    ["-C", checkout, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim();

  assert.doesNotThrow(() => verifySourceCheckout(checkout, actualCommit));
  assert.throws(
    () =>
      verifySourceCheckout(
        checkout,
        "0000000000000000000000000000000000000000"
      ),
    /expected 0000000000000000000000000000000000000000/u
  );
});
