import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGoLintLane,
  buildGoTestLane,
  buildPackageTestCommand,
  discoverGoModuleRoots,
  isBuiltinGenerateRequired,
  resolveGoModuleRoot,
  resolveGoValidationTargets
} from "./run-check-changed-targets.mjs";

const goModuleRoots = [
  "apps/cli",
  "packages/agent/daemon",
  "packages/agent/session-replay",
  "packages/agent/store-sqlite",
  "packages/agent/store-sqlite/canonical",
  "packages/clients/market-go",
  "packages/connector/daemon",
  "packages/connector/host",
  "packages/connector/runtime",
  "packages/connector/store-sqlite",
  "packages/device-link",
  "packages/events/stream-go",
  "packages/workspace/issues",
  "services/tuttid"
];

describe("discoverGoModuleRoots", () => {
  it("reads every module from go.work instead of a maintained whitelist", () => {
    const roots = discoverGoModuleRoots({
      root: "/repo",
      spawnSyncImpl: () => ({
        status: 0,
        stdout: JSON.stringify({
          Use: [
            { DiskPath: "./packages/connector/host" },
            { DiskPath: "./packages/agent/session-replay" },
            { DiskPath: "./services/tuttid" }
          ]
        })
      })
    });

    assert.deepEqual(roots, [
      "packages/agent/session-replay",
      "packages/connector/host",
      "services/tuttid"
    ]);
  });
});

describe("resolveGoModuleRoot", () => {
  it("maps changed files to their Go module root", () => {
    assert.equal(
      resolveGoModuleRoot(
        "services/tuttid/service/workspace/apps_install_progress.go",
        goModuleRoots
      ),
      "services/tuttid"
    );
    assert.equal(
      resolveGoModuleRoot("apps/cli/internal/app/foo.go", goModuleRoots),
      "apps/cli"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/agent/session-replay/replay.go",
        goModuleRoots
      ),
      "packages/agent/session-replay"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/connector/host/application.go",
        goModuleRoots
      ),
      "packages/connector/host"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/clients/market-go/client.go",
        goModuleRoots
      ),
      "packages/clients/market-go"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/agent/store-sqlite/store.go",
        goModuleRoots
      ),
      "packages/agent/store-sqlite"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/agent/store-sqlite/canonical/vocabulary.go",
        goModuleRoots
      ),
      "packages/agent/store-sqlite/canonical"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/device-link/mobile/probe.go",
        goModuleRoots
      ),
      "packages/device-link"
    );
    assert.equal(
      resolveGoModuleRoot("packages/events/stream-go/stream.go", goModuleRoots),
      "packages/events/stream-go"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/workspace/issues/service.go",
        goModuleRoots
      ),
      "packages/workspace/issues"
    );
  });
});

describe("resolveGoValidationTargets", () => {
  it("scopes lint and test targets to changed Go packages", () => {
    const targets = resolveGoValidationTargets(
      [
        "services/tuttid/service/workspace/apps_install_progress.go",
        "services/tuttid/service/workspace/apps_install_progress_test.go"
      ],
      { moduleRoots: goModuleRoots }
    );

    assert.deepEqual(Array.from(targets.lintByModule.get("services/tuttid")), [
      "./service/workspace"
    ]);
    assert.deepEqual(Array.from(targets.testByModule.get("services/tuttid")), [
      "./service/workspace/..."
    ]);
  });

  it("runs the full module when go.mod changes", () => {
    const targets = resolveGoValidationTargets(["services/tuttid/go.mod"], {
      moduleRoots: goModuleRoots
    });

    assert.deepEqual(Array.from(targets.testByModule.get("services/tuttid")), [
      "./..."
    ]);
  });

  it("skips deleted Go packages when the path no longer exists", () => {
    const targets = resolveGoValidationTargets(
      [
        "packages/agent/daemon/activity/hostquery/service.go",
        "packages/agent/daemon/activity/ingress/service.go",
        "packages/agent/daemon/internal/guestdesktoprelay/v1/types.go"
      ],
      { moduleRoots: goModuleRoots, pathExists: () => false }
    );

    assert.equal(targets, null);
  });

  it("keeps Go lanes for deleted files inside existing packages", () => {
    const targets = resolveGoValidationTargets(
      ["services/tuttid/service/workspace/deleted_file.go"],
      { moduleRoots: goModuleRoots, pathExists: () => true }
    );

    assert.deepEqual(Array.from(targets.lintByModule.get("services/tuttid")), [
      "./service/workspace"
    ]);
    assert.deepEqual(Array.from(targets.testByModule.get("services/tuttid")), [
      "./service/workspace/..."
    ]);
  });

  it("does not create Go lanes for shared selector scripts", () => {
    const targets = resolveGoValidationTargets(
      ["tools/scripts/run-changed-go-validation.mjs"],
      {
        moduleRoots: goModuleRoots,
        pathExists: () => true
      }
    );

    assert.equal(targets, null);
  });
});

describe("buildPackageTestCommand", () => {
  it("runs only changed test files", () => {
    const command = buildPackageTestCommand({
      baseRef: "origin/main",
      fileExists: () => true,
      packageFiles: [
        "packages/agent/gui/agent-gui/agentGuiNode/AgentComposerSettingsMenus.spec.tsx"
      ],
      packageInfo: {
        name: "@tutti-os/agent-gui",
        root: "packages/agent/gui",
        scripts: {
          test: "vitest run --environment jsdom"
        }
      },
      pnpmCommand: "pnpm"
    });

    assert.deepEqual(command, [
      "pnpm",
      "--filter",
      "@tutti-os/agent-gui",
      "exec",
      "vitest",
      "run",
      "--environment",
      "jsdom",
      "agent-gui/agentGuiNode/AgentComposerSettingsMenus.spec.tsx"
    ]);
  });

  it("skips package test lanes for deleted test files", () => {
    const command = buildPackageTestCommand({
      baseRef: "origin/main",
      fileExists: () => false,
      packageFiles: [
        "packages/ui/system/src/components/style-contracts.test.ts"
      ],
      packageInfo: {
        name: "@tutti-os/ui-system",
        root: "packages/ui/system",
        scripts: {
          test: "vitest run"
        }
      },
      pnpmCommand: "pnpm"
    });

    assert.equal(command, null);
  });

  it("uses vitest --changed for source-only package changes", () => {
    const command = buildPackageTestCommand({
      baseRef: "origin/main",
      packageFiles: [
        "packages/agent/gui/agent-gui/agentGuiNode/AgentComposer.tsx"
      ],
      packageInfo: {
        name: "@tutti-os/agent-gui",
        root: "packages/agent/gui",
        scripts: {
          test: "vitest run --environment jsdom"
        }
      },
      pnpmCommand: "pnpm"
    });

    assert.deepEqual(command, [
      "pnpm",
      "--filter",
      "@tutti-os/agent-gui",
      "exec",
      "vitest",
      "run",
      "--environment",
      "jsdom",
      "--changed",
      "origin/main"
    ]);
  });

  it("uses the package test script for compound vitest scripts", () => {
    const command = buildPackageTestCommand({
      baseRef: "origin/main",
      fileExists: () => true,
      packageFiles: [
        "services/tuttid/builtin-apps/tutti-onboarding/src/App.test.jsx"
      ],
      packageInfo: {
        name: "@tutti-os/builtin-tutti-onboarding",
        root: "services/tuttid/builtin-apps/tutti-onboarding",
        scripts: {
          test: "vitest run && node scripts/check-assets.mjs"
        }
      },
      pnpmCommand: "pnpm"
    });

    assert.deepEqual(command, [
      "pnpm",
      "--filter",
      "@tutti-os/builtin-tutti-onboarding",
      "test"
    ]);
  });

  it("runs the full package test script for source-only compound scripts", () => {
    const command = buildPackageTestCommand({
      baseRef: "origin/main",
      packageFiles: [
        "services/tuttid/builtin-apps/tutti-onboarding/src/App.jsx"
      ],
      packageInfo: {
        name: "@tutti-os/builtin-tutti-onboarding",
        root: "services/tuttid/builtin-apps/tutti-onboarding",
        scripts: {
          test: "vitest run && node scripts/check-assets.mjs"
        }
      },
      pnpmCommand: "pnpm"
    });

    assert.deepEqual(command, [
      "pnpm",
      "--filter",
      "@tutti-os/builtin-tutti-onboarding",
      "test"
    ]);
  });
});

describe("builtin onboarding ensure", () => {
  it("requires full generate when onboarding sources change", () => {
    assert.equal(
      isBuiltinGenerateRequired([
        "services/tuttid/builtin-apps/tutti-onboarding/src/App.jsx"
      ]),
      true
    );
    assert.equal(
      isBuiltinGenerateRequired([
        "services/tuttid/builtin-apps/generated/tutti-onboarding/placeholder.txt"
      ]),
      false
    );
  });

  it("prepends ensure commands for tuttid Go tests", () => {
    const lane = buildGoTestLane({
      moduleRoot: "services/tuttid",
      targets: new Set(["./service/workspace/..."]),
      pnpmCommand: "pnpm",
      shellQuote: (value) => value,
      forceBuiltinGenerate: false
    });

    assert.match(lane.command[2], /package:builtin:check/);
    assert.match(lane.command[2], /generate:builtin-apps\) && cd/);
    assert.match(lane.command[2], /go test \.\/service\/workspace\/\.\.\./);
  });
  it("requires forced builtin generation before tuttid Go tests", () => {
    const lane = buildGoTestLane({
      moduleRoot: "services/tuttid",
      targets: new Set(["./service/workspace/..."]),
      pnpmCommand: "pnpm",
      shellQuote: (value) => value,
      forceBuiltinGenerate: true
    });

    assert.match(lane.command[2], /^pnpm generate:builtin-apps/);
    assert.match(lane.command[2], /generate:builtin-apps && cd/);
  });
});

describe("buildGoLintLane", () => {
  it("ensures builtin assets before linting tuttid", () => {
    const lane = buildGoLintLane({
      forceBuiltinGenerate: false,
      golangciLintBinary: "/tmp/go/bin/golangci-lint",
      moduleRoot: "services/tuttid",
      pnpmCommand: "pnpm",
      targets: new Set(["./service/workspace/..."]),
      workspaceRoot: "/repo",
      shellQuote: (value) => value
    });

    assert.match(lane.command[2], /package:builtin:check/);
    assert.match(lane.command[2], /generate:builtin-apps\) && cd/);
    assert.match(lane.command[2], /\/tmp\/go\/bin\/golangci-lint run/);
    assert.match(lane.command[2], /--allow-parallel-runners/);
  });
});
