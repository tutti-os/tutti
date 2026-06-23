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
});

describe("buildPackageTestCommand", () => {
  it("runs only changed test files", () => {
    const command = buildPackageTestCommand({
      baseRef: "origin/main",
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
    assert.match(lane.command[2], /generate:builtin-apps;/);
    assert.match(lane.command[2], /go test \.\/service\/workspace\/\.\.\./);
  });
});

describe("buildGoLintLane", () => {
  it("does not run generate:builtin-apps", () => {
    const lane = buildGoLintLane({
      moduleRoot: "services/tuttid",
      targets: new Set(["./service/workspace/..."]),
      workspaceRoot: "/repo",
      shellQuote: (value) => value
    });

    assert.doesNotMatch(lane.command[2], /generate:builtin-apps/);
    assert.match(lane.command[2], /golangci-lint run/);
  });
});
