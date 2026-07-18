import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { rewriteInternalGoModuleDependencies } from "./go-module-release.mjs";
import { workspaceRoot } from "./npm-release-packages.mjs";

test("rewrites internal requirements and removes local replaces", () => {
  const input = `module example.test/consumer

require (
  github.com/tutti-os/tutti/packages/agent/daemon v0.0.0
  example.test/external v1.2.3
)

replace (
  github.com/tutti-os/tutti/packages/agent/daemon => ../daemon
  example.test/external => ../external
)

replace github.com/tutti-os/tutti/packages/workspace/files => ../files
`;

  assert.equal(
    rewriteInternalGoModuleDependencies(input, "0.0.110"),
    `module example.test/consumer

require (
  github.com/tutti-os/tutti/packages/agent/daemon v0.0.110
  example.test/external v1.2.3
)

replace (
  example.test/external => ../external
)
`
  );
});

test("published activity contract keeps a light canonical-only module graph", async () => {
  const source = await readFile(
    join(workspaceRoot, "packages/agent/activity-replication/go.mod"),
    "utf8"
  );
  const released = rewriteInternalGoModuleDependencies(source, "0.0.110");

  assert.match(
    released,
    /github\.com\/tutti-os\/tutti\/packages\/agent\/store-sqlite\/canonical v0\.0\.110/
  );
  assert.doesNotMatch(released, /replace .*github\.com\/tutti-os\/tutti/);
  assert.doesNotMatch(released, /packages\/agent\/daemon|modernc\.org\/sqlite/);
});

test("published store module resolves every internal dependency at the release version", async () => {
  const source = await readFile(
    join(workspaceRoot, "packages/agent/store-sqlite/go.mod"),
    "utf8"
  );
  const released = rewriteInternalGoModuleDependencies(source, "0.0.110");

  for (const modulePath of ["activity-replication", "store-sqlite/canonical"]) {
    assert.match(
      released,
      new RegExp(
        `github\\.com/tutti-os/tutti/packages/agent/${modulePath.replace("/", "\\/")} v0\\.0\\.110`
      )
    );
  }
  assert.doesNotMatch(released, /replace .*github\.com\/tutti-os\/tutti/);
  assert.doesNotMatch(released, /packages\/agent\/daemon/);
});

test("published host contract contains only reusable agent package dependencies", async () => {
  const source = await readFile(
    join(workspaceRoot, "packages/agent/host/go.mod"),
    "utf8"
  );
  const released = rewriteInternalGoModuleDependencies(source, "0.0.110");

  for (const modulePath of [
    "activity-replication",
    "store-sqlite",
    "store-sqlite/canonical"
  ]) {
    assert.match(
      released,
      new RegExp(
        `github\\.com/tutti-os/tutti/packages/agent/${modulePath.replace("/", "\\/")} v0\\.0\\.110`
      )
    );
  }
  assert.doesNotMatch(released, /replace .*github\.com\/tutti-os\/tutti/);
  assert.doesNotMatch(
    released,
    /packages\/agent\/daemon|services\/tuttid|sidecar/
  );
});

test("leaves modules without internal dependencies byte-for-byte unchanged", () => {
  const source =
    "module example.test/standalone\n\nrequire example.test/api v1.2.3\n\n";
  assert.equal(rewriteInternalGoModuleDependencies(source, "0.0.110"), source);
});
