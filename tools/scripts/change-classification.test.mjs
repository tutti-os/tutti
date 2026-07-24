import assert from "node:assert/strict";
import test from "node:test";

import { classifyChangedFiles } from "./change-classification.mjs";
import { selectRepositoryChecks } from "./repository-checks.mjs";

const releasePackageRoots = ["packages/agent/gui", "packages/ui/system"];

test("Go-only changes do not select TypeScript validation", () => {
  const classification = classifyChangedFiles(
    ["services/tuttid/service/workspace/apps.go"],
    { releasePackageRoots }
  );

  assert.equal(classification.runGo, true);
  assert.equal(classification.runTs, false);
  assert.equal(classification.runPack, false);
  assert.equal(classification.runBoundaries, true);
});

test("generated source files select generated contracts before outputs change", () => {
  for (const file of [
    "config/tutti.defaults.json",
    "services/tuttid/api/openapi/tuttid.v1.yaml",
    "packages/events/protocol/definitions/agent/activity.updated.event.json",
    "packages/workbench/snapshot/src/schema.json"
  ]) {
    const classification = classifyChangedFiles([file], {
      releasePackageRoots
    });
    assert.equal(classification.runGenerated, true, file);
  }
});

test("workflow and hook changes select repository tool contracts", () => {
  for (const file of [
    ".github/workflows/desktop-release.yml",
    ".github/workflows/publish-tutti-app-release.yml",
    ".husky/pre-push"
  ]) {
    const classification = classifyChangedFiles([file], {
      releasePackageRoots
    });
    assert.equal(classification.runContracts, true, file);
  }
});

test("published CSS and assets select package packing and UI boundaries", () => {
  for (const file of [
    "packages/agent/gui/app/renderer/agentactivity.css",
    "packages/ui/system/src/icons/recent-lined.svg"
  ]) {
    const classification = classifyChangedFiles([file], {
      releasePackageRoots
    });
    assert.equal(classification.runPack, true, file);
    assert.equal(classification.runBoundaries, true, file);
    assert.equal(classification.runTs, false, file);
  }
});

test("deleted package manifests still select package packing", () => {
  const classification = classifyChangedFiles(
    ["packages/example/removed/package.json"],
    { releasePackageRoots }
  );

  assert.equal(classification.runPack, true);
});

test("repository check registry selects only relevant generated checks", () => {
  const checks = selectRepositoryChecks(
    ["packages/events/protocol/schemas/core/event-envelope.schema.json"],
    { group: "generated" }
  );

  assert.deepEqual(
    checks.map((check) => check.key),
    ["generated:event-protocol"]
  );
});

test("provider source changes select catalog and strategy checks", () => {
  const checks = selectRepositoryChecks([
    "packages/agent/daemon/providerregistry/providers.go"
  ]);
  const keys = checks.map((check) => check.key);

  assert.ok(keys.includes("generated:agent-provider-catalog"));
  assert.ok(keys.includes("boundary:agent-provider-strategy"));
});

test("every DeviceLink package change selects the Android contract", () => {
  for (const file of [
    "packages/device-link/mobile/mobile.go",
    "packages/device-link/Makefile",
    "packages/device-link/mobile/androidprobe/AndroidManifest.xml"
  ]) {
    const checks = selectRepositoryChecks([file]);
    assert.ok(
      checks.some((check) => check.key === "contracts:device-link-android"),
      `${file} should select the DeviceLink Android contract`
    );
  }
});

test("stylesheet and HTML changes select the backdrop-filter authoring policy", () => {
  for (const file of [
    "packages/workbench/launchpad/src/styles/workbench-launchpad.css",
    "apps/desktop/index.html"
  ]) {
    const checks = selectRepositoryChecks([file]);

    assert.ok(
      checks.some((check) => check.key === "policy:backdrop-filter-authoring"),
      `${file} should select the backdrop-filter policy`
    );
  }
});

test("stylesheet changes select the CSS :has() performance policy", () => {
  const checks = selectRepositoryChecks([
    "packages/agent/gui/app/renderer/agentactivity.css"
  ]);

  assert.ok(checks.some((check) => check.key === "policy:css-has-performance"));
});

test("bounded runtime image changes select the image budget policy", () => {
  const checks = selectRepositoryChecks([
    "apps/desktop/src/renderer/src/assets/workspace-canvas/dock/default/codex.png"
  ]);

  assert.ok(
    checks.some((check) => check.key === "policy:runtime-image-budgets")
  );
});
