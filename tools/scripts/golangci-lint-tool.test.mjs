import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { delimiter, join } from "node:path";
import { resolveGolangciLintBinary } from "./golangci-lint-tool.mjs";

describe("resolveGolangciLintBinary", () => {
  it("finds the repository-prescribed GOPATH installation without PATH", () => {
    const first = join("", "tmp", "go-first");
    const second = join("", "tmp", "go-second");
    const expected = join(second, "bin", "golangci-lint");
    const actual = resolveGolangciLintBinary({
      pathExists: (candidate) => candidate === expected,
      platform: "darwin",
      spawnSyncImpl: () => ({
        status: 0,
        stdout: `${first}${delimiter}${second}\n`
      })
    });
    assert.equal(actual, expected);
  });

  it("falls back to PATH when Go cannot resolve GOPATH", () => {
    const actual = resolveGolangciLintBinary({
      platform: "linux",
      spawnSyncImpl: () => ({ error: { code: "ENOENT" }, status: null })
    });
    assert.equal(actual, "golangci-lint");
  });
});
