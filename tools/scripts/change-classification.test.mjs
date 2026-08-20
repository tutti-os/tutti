import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTypeScriptTestShards,
  classifyChangedFiles,
  createPackageManifestPackRelevance,
  createRootManifestTestRelevance
} from "./change-classification.mjs";
import { createIsolatedGitEnvironment } from "./git-environment.mjs";
import { selectRepositoryChecks } from "./repository-checks.mjs";

const releasePackages = [
  { name: "@tutti-os/agent-gui", root: "packages/agent/gui" },
  { name: "@tutti-os/ui-system", root: "packages/ui/system" }
];
const workspacePackages = [
  {
    hasTests: true,
    name: "@tutti-os/agent-gui",
    root: "packages/agent/gui"
  },
  {
    hasTests: true,
    name: "@tutti-os/desktop",
    root: "apps/desktop",
    workspaceDependencies: ["@tutti-os/agent-gui"]
  },
  {
    hasTests: false,
    name: "@tutti-os/no-tests",
    root: "packages/example/no-tests"
  }
];

test("builds no more TypeScript test shards than selected packages", () => {
  assert.deepEqual(buildTypeScriptTestShards([]), ["1/1"]);
  assert.deepEqual(buildTypeScriptTestShards(["one"]), ["1/1"]);
  assert.deepEqual(buildTypeScriptTestShards(["one", "two"]), ["1/2", "2/2"]);
  assert.deepEqual(buildTypeScriptTestShards(["one", "two", "three", "four"]), [
    "1/3",
    "2/3",
    "3/3"
  ]);
});

test("Go-only changes do not select TypeScript validation", () => {
  const classification = classifyChangedFiles(
    ["services/tuttid/service/workspace/apps.go"],
    { releasePackages }
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
      releasePackages
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
      releasePackages
    });
    assert.equal(classification.runContracts, true, file);
  }
});

test("Go CI and shared selector changes use tool contracts instead of all Go lanes", () => {
  for (const file of [
    ".github/workflows/pr-checks.yml",
    "tools/scripts/run-changed-go-validation.mjs",
    "tools/scripts/run-check-changed-targets.mjs"
  ]) {
    const classification = classifyChangedFiles([file], {
      releasePackages
    });
    assert.equal(classification.runGo, false, file);
    assert.equal(classification.runContracts, true, file);
  }
});

test("Agent Session Replay changes select the current-build closed loop", () => {
  for (const file of [
    "packages/agent/session-replay/cassette.go",
    "packages/agent/daemon/runtime/process_transport_session_replay.go",
    "services/tuttid/agent_session_recording.go",
    "services/tuttid/data/workspace/migrations_agent_session_replay.go",
    "apps/desktop/src/main/agentSessionReplayProcessManager.ts",
    "apps/desktop/src/renderer/src/features/agent-session-replay/services/agentSessionReplayService.ts",
    "tools/scripts/run-agent-session-replay.mjs"
  ]) {
    const classification = classifyChangedFiles([file], {
      releasePackages
    });
    assert.equal(classification.runAgentSessionReplay, true, file);
  }
});

test("unrelated UI changes do not select the Agent Session Replay closed loop", () => {
  const classification = classifyChangedFiles(
    ["apps/desktop/src/renderer/src/features/settings/Settings.tsx"],
    { releasePackages }
  );

  assert.equal(classification.runAgentSessionReplay, false);
});

test("ordinary Desktop source changes skip the Windows installer", () => {
  for (const file of [
    "apps/desktop/src/main/index.ts",
    "apps/desktop/src/preload/index.ts",
    "apps/desktop/src/renderer/src/main.tsx",
    "apps/desktop/test/register-asset-stub.mjs",
    "apps/desktop/electron.vite.config.ts",
    "apps/desktop/tsconfig.json"
  ]) {
    const classification = classifyChangedFiles([file], { releasePackages });

    assert.equal(classification.buildWindowsInstaller, false, file);
  }
});

test("Windows packaging inputs select the Windows installer", () => {
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "apps/desktop/package.json",
    "apps/desktop/build/icon.png",
    "apps/desktop/scripts/vendor-managed-posix-shell.mjs",
    "services/tuttid/builtin-apps/tutti-onboarding/src/main.ts"
  ]) {
    const classification = classifyChangedFiles([file], { releasePackages });

    assert.equal(classification.buildWindowsInstaller, true, file);
  }
});

test("published CSS and assets select package packing and UI boundaries", () => {
  for (const file of [
    "packages/agent/gui/app/renderer/agentactivity.css",
    "packages/ui/system/src/icons/recent-lined.svg"
  ]) {
    const classification = classifyChangedFiles([file], {
      releasePackages
    });
    assert.equal(classification.runPack, true, file);
    assert.equal(classification.runBoundaries, true, file);
    assert.equal(classification.runTs, false, file);
  }
});

test("deleted package manifests still select package packing", () => {
  const classification = classifyChangedFiles(
    ["packages/example/removed/package.json"],
    { releasePackages }
  );

  assert.equal(classification.runPack, true);
  assert.equal(classification.packAll, true);
  assert.deepEqual(classification.packPackages, [
    "@tutti-os/agent-gui",
    "@tutti-os/ui-system"
  ]);
});

test("test files and Vitest support files do not select package packing", () => {
  const classification = classifyChangedFiles(
    [
      "packages/agent/gui/agent-gui/controller.spec.ts",
      "packages/agent/gui/vitest.config.ts",
      "packages/agent/gui/vitest.shared.setup.ts"
    ],
    { releasePackages }
  );

  assert.equal(classification.runPack, false);
  assert.deepEqual(classification.packPackages, []);
});

test("test-only package manifest changes do not select package packing", () => {
  const classification = classifyChangedFiles(
    ["packages/agent/gui/package.json"],
    {
      isPackageManifestPackRelevant: () => false,
      releasePackages
    }
  );

  assert.equal(classification.runPack, false);
});

test("publish-relevant package manifest changes select every package", () => {
  const classification = classifyChangedFiles(
    ["packages/agent/gui/package.json"],
    { releasePackages }
  );

  assert.equal(classification.packAll, true);
  assert.deepEqual(classification.packPackages, [
    "@tutti-os/agent-gui",
    "@tutti-os/ui-system"
  ]);
});

test("package manifest comparison ignores only test scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "package-manifest-pack-"));
  const packageRoot = join(root, "packages/agent/gui");
  const manifestPath = join(packageRoot, "package.json");
  const gitEnv = createIsolatedGitEnvironment(root);
  const runGit = (args) =>
    execFileSync("git", args, { cwd: root, env: gitEnv });
  mkdirSync(packageRoot, { recursive: true });

  try {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: "@tutti-os/agent-gui",
        scripts: { build: "tsup", test: "vitest run --old" }
      })}\n`
    );
    runGit(["init", "--quiet"]);
    runGit(["add", "."]);
    runGit([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "init"
    ]);
    const isRelevant = createPackageManifestPackRelevance({
      baseRef: "HEAD",
      root
    });

    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: "@tutti-os/agent-gui",
        scripts: { build: "tsup", test: "vitest run" }
      })}\n`
    );
    assert.equal(isRelevant("packages/agent/gui/package.json"), false);

    const buildChangeIsRelevant = createPackageManifestPackRelevance({
      baseRef: "HEAD",
      root
    });
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: "@tutti-os/agent-gui",
        scripts: { build: "tsup --config tsup.config.ts", test: "vitest run" }
      })}\n`
    );
    assert.equal(
      buildChangeIsRelevant("packages/agent/gui/package.json"),
      true
    );

    runGit(["add", "."]);
    runGit([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "change build"
    ]);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: "@tutti-os/agent-gui",
        scripts: {
          build: "tsup --config tsup.config.ts",
          test: "vitest run --working-copy"
        }
      })}\n`
    );
    const committedBuildChangeIsRelevant = createPackageManifestPackRelevance({
      baseRef: "HEAD^",
      root
    });
    assert.equal(
      committedBuildChangeIsRelevant("packages/agent/gui/package.json"),
      true
    );

    const headRef = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      env: gitEnv
    }).trim();
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        name: "@tutti-os/agent-gui",
        scripts: {
          build: "tsup --working-copy",
          test: "vitest run --working-copy"
        }
      })}\n`
    );
    assert.equal(
      createPackageManifestPackRelevance({
        baseRef: "HEAD",
        headRef,
        root
      })("packages/agent/gui/package.json"),
      false
    );
    assert.equal(
      createPackageManifestPackRelevance({
        baseRef: "HEAD",
        root
      })("packages/agent/gui/package.json"),
      true
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("published package changes select only their owning package", () => {
  const classification = classifyChangedFiles(["packages/agent/gui/index.ts"], {
    releasePackages
  });

  assert.equal(classification.runPack, true);
  assert.equal(classification.packAll, false);
  assert.deepEqual(classification.packPackages, ["@tutti-os/agent-gui"]);
});

test("global release inputs select every published package", () => {
  const classification = classifyChangedFiles(["pnpm-lock.yaml"], {
    releasePackages
  });

  assert.equal(classification.runPack, true);
  assert.equal(classification.packAll, true);
  assert.deepEqual(classification.packPackages, [
    "@tutti-os/agent-gui",
    "@tutti-os/ui-system"
  ]);
});

test("tool-only changes do not select workspace package tests", () => {
  const classification = classifyChangedFiles(
    ["tools/scripts/check-package-packs.mjs"],
    {
      isRootManifestTestRelevant: () => false,
      releasePackages,
      workspacePackages
    }
  );

  assert.equal(classification.runTs, true);
  assert.equal(classification.runTsTests, false);
  assert.deepEqual(classification.testPackages, []);
});

test("package changes select owning and dependent package tests", () => {
  const classification = classifyChangedFiles(
    ["packages/agent/gui/controller.spec.ts"],
    { releasePackages, workspacePackages }
  );

  assert.equal(classification.runTsTests, true);
  assert.equal(classification.testAll, false);
  assert.deepEqual(classification.testPackages, [
    "@tutti-os/agent-gui",
    "@tutti-os/desktop"
  ]);
});

test("packages without tests do not select workspace package tests", () => {
  const classification = classifyChangedFiles(
    ["packages/example/no-tests/index.ts"],
    { releasePackages, workspacePackages }
  );

  assert.equal(classification.runTsTests, false);
});

test("global test inputs select every workspace test package", () => {
  const classification = classifyChangedFiles(["pnpm-lock.yaml"], {
    releasePackages,
    workspacePackages
  });

  assert.equal(classification.runTsTests, true);
  assert.equal(classification.testAll, true);
  assert.deepEqual(classification.testPackages, [
    "@tutti-os/agent-gui",
    "@tutti-os/desktop"
  ]);
});

test("deleted package manifests select every workspace test package", () => {
  const classification = classifyChangedFiles(
    ["packages/example/deleted/package.json"],
    { releasePackages, workspacePackages }
  );

  assert.equal(classification.testAll, true);
});

test("root manifest comparison ignores unrelated scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "root-manifest-tests-"));
  const manifestPath = join(root, "package.json");
  const gitEnv = createIsolatedGitEnvironment(root);
  const runGit = (args) =>
    execFileSync("git", args, { cwd: root, env: gitEnv });

  try {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        packageManager: "pnpm@10.11.0",
        scripts: {
          "release:pack:check": "old",
          "test:ts": "node test.mjs"
        }
      })}\n`
    );
    runGit(["init", "--quiet"]);
    runGit(["add", "."]);
    runGit([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "init"
    ]);

    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        packageManager: "pnpm@10.11.0",
        scripts: {
          "release:pack:check": "new",
          "test:ts": "node test.mjs"
        }
      })}\n`
    );
    assert.equal(
      createRootManifestTestRelevance({
        baseRef: "HEAD",
        root
      })(),
      false
    );

    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        packageManager: "pnpm@10.11.0",
        scripts: {
          "release:pack:check": "new",
          "test:ts": "node changed-test.mjs"
        }
      })}\n`
    );
    assert.equal(
      createRootManifestTestRelevance({
        baseRef: "HEAD",
        root
      })(),
      true
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
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
