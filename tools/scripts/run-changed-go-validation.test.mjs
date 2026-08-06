import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildChangedGoValidationLanes,
  parseChangedGoValidationArgs
} from "./run-changed-go-validation.mjs";

const moduleRoots = [
  "packages/agent/daemon",
  "packages/agent/session-replay",
  "services/tuttid"
];

describe("parseChangedGoValidationArgs", () => {
  it("parses the CI selection options", () => {
    assert.deepEqual(
      parseChangedGoValidationArgs([
        "--base",
        "base-sha",
        "--kind",
        "test",
        "--max-parallel",
        "2",
        "--tail-lines",
        "400"
      ]),
      {
        baseRef: "base-sha",
        kind: "test",
        maxParallel: 2,
        tailLines: 400
      }
    );
  });

  it("rejects an incomplete selector", () => {
    assert.throws(
      () => parseChangedGoValidationArgs(["--kind", "test"]),
      /--base is required/
    );
    assert.throws(
      () =>
        parseChangedGoValidationArgs(["--base", "base-sha", "--kind", "all"]),
      /--kind requires lint or test/
    );
  });
});

describe("buildChangedGoValidationLanes", () => {
  it("runs only the changed package for an ordinary Go change", () => {
    const lanes = buildChangedGoValidationLanes({
      changedFiles: ["packages/agent/daemon/runtime/session.go"],
      kind: "test",
      moduleRoots,
      pathExists: () => true,
      root: "/repo"
    });

    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].label, "test:go (packages/agent/daemon)");
    assert.match(
      lanes[0].command[2],
      /cd packages\/agent\/daemon && go test \.\/runtime\/\.\.\./
    );
  });

  it("uses the same package scope for lint", () => {
    const lanes = buildChangedGoValidationLanes({
      changedFiles: ["packages/agent/daemon/runtime/session.go"],
      kind: "lint",
      moduleRoots,
      pathExists: () => true,
      root: "/repo"
    });

    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].label, "lint:go (packages/agent/daemon)");
    assert.match(lanes[0].command[2], /golangci-lint run/);
    assert.match(lanes[0].command[2], / \.\/runtime$/);
    assert.doesNotMatch(lanes[0].command[2], /generate:builtin-apps/);
  });

  it("does not expand lint beyond the established lint module set", () => {
    const lanes = buildChangedGoValidationLanes({
      changedFiles: ["packages/agent/session-replay/replay.go"],
      kind: "lint",
      moduleRoots,
      pathExists: () => true,
      root: "/repo"
    });

    assert.deepEqual(lanes, []);
  });

  it("falls back to every module when shared selection code changes", () => {
    const lanes = buildChangedGoValidationLanes({
      changedFiles: ["tools/scripts/run-changed-go-validation.mjs"],
      kind: "test",
      moduleRoots,
      pathExists: () => true,
      root: "/repo"
    });

    assert.deepEqual(
      lanes.map((lane) => lane.label),
      moduleRoots.map((moduleRoot) => `test:go (${moduleRoot})`)
    );
    for (const lane of lanes) {
      assert.match(lane.command[2], /go test \.\/\.\.\./);
    }
  });

  it("ensures builtin assets only for the selected tuttid lane", () => {
    const lanes = buildChangedGoValidationLanes({
      changedFiles: ["services/tuttid/service/workspace/apps.go"],
      kind: "test",
      moduleRoots,
      pathExists: () => true,
      root: "/repo"
    });

    assert.equal(lanes.length, 1);
    assert.match(lanes[0].command[2], /package:builtin:check/);
    assert.match(lanes[0].command[2], /go test \.\/service\/workspace\/\.\.\./);
  });
});
