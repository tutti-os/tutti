import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildGoLintLane,
  buildGoTestLane,
  buildPackageTestCommand,
  isBuiltinGenerateRequired,
  resolveGoModuleRoot,
  resolveGoValidationTargets
} from "./run-check-changed-targets.mjs";

describe("resolveGoModuleRoot", () => {
  it("maps changed files to their Go module root", () => {
    assert.equal(
      resolveGoModuleRoot(
        "services/tuttid/service/workspace/apps_install_progress.go"
      ),
      "services/tuttid"
    );
    assert.equal(
      resolveGoModuleRoot("apps/cli/internal/app/foo.go"),
      "apps/cli"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/agent/activity-replication/conformance/fixtures.go"
      ),
      "packages/agent/activity-replication"
    );
    assert.equal(
      resolveGoModuleRoot("packages/agent/host/conformance/conformance.go"),
      "packages/agent/host"
    );
    assert.equal(
      resolveGoModuleRoot("packages/agent/runtimeprep/preparer.go"),
      "packages/agent/runtimeprep"
    );
    assert.equal(
      resolveGoModuleRoot("packages/agent/store-sqlite/store.go"),
      "packages/agent/store-sqlite"
    );
    assert.equal(
      resolveGoModuleRoot(
        "packages/agent/store-sqlite/canonical/vocabulary.go"
      ),
      "packages/agent/store-sqlite/canonical"
    );
    assert.equal(
      resolveGoModuleRoot("packages/auth/bridge-go/bridge.go"),
      "packages/auth/bridge-go"
    );
    assert.equal(
      resolveGoModuleRoot("packages/device-link/mobile/probe.go"),
      "packages/device-link"
    );
    assert.equal(
      resolveGoModuleRoot("packages/events/stream-go/stream.go"),
      "packages/events/stream-go"
    );
    assert.equal(
      resolveGoModuleRoot("packages/workspace/issues/service.go"),
      "packages/workspace/issues"
    );
  });
});

describe("resolveGoValidationTargets", () => {
  it("scopes lint and test targets to changed Go packages", () => {
    const targets = resolveGoValidationTargets([
      "services/tuttid/service/workspace/apps_install_progress.go",
      "services/tuttid/service/workspace/apps_install_progress_test.go"
    ]);

    assert.deepEqual(Array.from(targets.lintByModule.get("services/tuttid")), [
      "./service/workspace"
    ]);
    assert.deepEqual(Array.from(targets.testByModule.get("services/tuttid")), [
      "./service/workspace/..."
    ]);
  });

  it("runs the full module when go.mod changes", () => {
    const targets = resolveGoValidationTargets(["services/tuttid/go.mod"]);

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
      { pathExists: () => false }
    );

    assert.equal(targets, null);
  });

  it("keeps Go lanes for deleted files inside existing packages", () => {
    const targets = resolveGoValidationTargets(
      ["services/tuttid/service/workspace/deleted_file.go"],
      { pathExists: () => true }
    );

    assert.deepEqual(Array.from(targets.lintByModule.get("services/tuttid")), [
      "./service/workspace"
    ]);
    assert.deepEqual(Array.from(targets.testByModule.get("services/tuttid")), [
      "./service/workspace/..."
    ]);
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
  it("does not run generate:builtin-apps", () => {
    const lane = buildGoLintLane({
      golangciLintBinary: "/tmp/go/bin/golangci-lint",
      moduleRoot: "services/tuttid",
      targets: new Set(["./service/workspace/..."]),
      workspaceRoot: "/repo",
      shellQuote: (value) => value
    });

    assert.doesNotMatch(lane.command[2], /generate:builtin-apps/);
    assert.match(lane.command[2], /\/tmp\/go\/bin\/golangci-lint run/);
    assert.match(lane.command[2], /--allow-parallel-runners/);
  });
});
