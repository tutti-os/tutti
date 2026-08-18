import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const GLOBAL_GO_VALIDATION_FILES = new Set(["go.work", "go.work.sum"]);

const GO_LINT_MODULE_ROOTS = new Set([
  "apps/cli",
  "packages/agent/activity-replication",
  "packages/agent/daemon",
  "packages/agent/host",
  "packages/agent/runtimeprep",
  "packages/agent/store-sqlite",
  "packages/agent/store-sqlite/canonical",
  "packages/appcli/core",
  "packages/auth/bridge-go",
  "packages/clients/device-authority-go",
  "packages/clients/market-go",
  "packages/connector/daemon",
  "packages/connector/host",
  "packages/connector/runtime",
  "packages/connector/store-sqlite",
  "packages/device-link",
  "packages/events/stream-go",
  "packages/workbench/service",
  "packages/workspace/files",
  "packages/workspace/issues",
  "services/tuttid"
]);

const GOLANGCI_CONFIG_RELATIVE_PATH = join(
  "services",
  "tuttid",
  ".golangci.yml"
);

export function discoverGoModuleRoots({
  root = process.cwd(),
  spawnSyncImpl = spawnSync
} = {}) {
  const result = spawnSyncImpl("go", ["work", "edit", "-json"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
        result.error?.message ||
        "go work edit -json failed"
    );
  }
  const workspace = JSON.parse(result.stdout);
  return (workspace.Use ?? [])
    .map((entry) =>
      relative(root, resolve(root, entry.DiskPath)).replaceAll("\\", "/")
    )
    .sort();
}

export function resolveGoModuleRoot(file, moduleRoots) {
  const normalized = file.replaceAll("\\", "/");
  const orderedRoots = [...moduleRoots].sort(
    (left, right) => right.length - left.length
  );
  for (const moduleRoot of orderedRoots) {
    if (normalized === moduleRoot || normalized.startsWith(`${moduleRoot}/`)) {
      return moduleRoot;
    }
  }
  return null;
}

export function selectGoLintModuleRoots(moduleRoots) {
  return moduleRoots.filter((moduleRoot) =>
    GO_LINT_MODULE_ROOTS.has(moduleRoot)
  );
}

export function isBuiltinGenerateRequired(changedFiles) {
  return changedFiles.some((file) => {
    const normalized = file.replaceAll("\\", "/");
    return (
      normalized.startsWith("services/tuttid/builtin-apps/tutti-onboarding/") &&
      !normalized.startsWith("services/tuttid/builtin-apps/generated/")
    );
  });
}

export function resolveGoValidationTargets(
  changedFiles,
  { moduleRoots, lintModuleRoots = moduleRoots, pathExists = existsSync }
) {
  const goFiles = changedFiles.filter(isGoValidationRelevant);
  if (goFiles.length === 0) {
    return null;
  }

  const lintByModule = new Map();
  const testByModule = new Map();
  const lintModuleRootSet = new Set(lintModuleRoots);

  if (goFiles.some(isGlobalGoValidationRelevant)) {
    for (const moduleRoot of moduleRoots) {
      if (!pathExists(moduleRoot)) {
        continue;
      }
      if (lintModuleRootSet.has(moduleRoot)) {
        addGoTarget(lintByModule, moduleRoot, "./...");
      }
      addGoTarget(testByModule, moduleRoot, "./...");
    }
  }

  for (const file of goFiles) {
    const moduleRoot = resolveGoModuleRoot(file, moduleRoots);
    if (!moduleRoot) {
      continue;
    }

    if (/(?:^|\/)go\.(?:mod|sum)$/u.test(file)) {
      if (!pathExists(moduleRoot)) {
        continue;
      }
      if (lintModuleRootSet.has(moduleRoot)) {
        addGoTarget(lintByModule, moduleRoot, "./...");
      }
      addGoTarget(testByModule, moduleRoot, "./...");
      continue;
    }

    if (!file.endsWith(".go")) {
      continue;
    }

    const packagePattern = goPackagePattern(moduleRoot, file);
    if (!pathExists(join(moduleRoot, packagePattern.slice(2)))) {
      continue;
    }
    if (lintModuleRootSet.has(moduleRoot)) {
      addGoTarget(lintByModule, moduleRoot, packagePattern);
    }
    addGoTarget(
      testByModule,
      moduleRoot,
      packagePattern === "." ? "." : `${packagePattern}/...`
    );
  }

  if (lintByModule.size === 0 && testByModule.size === 0) {
    return null;
  }

  return { lintByModule, testByModule };
}

export function buildGoLintLane({
  forceBuiltinGenerate,
  golangciLintBinary = "golangci-lint",
  moduleRoot,
  pnpmCommand,
  targets,
  workspaceRoot,
  shellQuote
}) {
  const golangciConfigPath = join(workspaceRoot, GOLANGCI_CONFIG_RELATIVE_PATH);
  const targetList = Array.from(targets).sort().join(" ");
  const builtinEnsure =
    moduleRoot === "services/tuttid"
      ? `${buildTuttidBuiltinEnsureCommand(pnpmCommand, {
          forceGenerate: forceBuiltinGenerate
        })} `
      : "";
  return {
    key: `lint:go:${sanitizeLaneKey(moduleRoot)}`,
    label: `lint:go (${moduleRoot})`,
    serialGroup:
      moduleRoot === "services/tuttid" ? "tuttid-builtin-assets" : undefined,
    command: [
      "bash",
      "-lc",
      `${builtinEnsure}cd ${shellQuote(moduleRoot)} && ${shellQuote(golangciLintBinary)} run --allow-parallel-runners --config ${shellQuote(golangciConfigPath)} ${targetList}`
    ]
  };
}

export function buildGoTestLane({
  moduleRoot,
  targets,
  pnpmCommand,
  shellQuote,
  forceBuiltinGenerate
}) {
  const targetList = Array.from(targets).sort().join(" ");
  const builtinEnsure =
    moduleRoot === "services/tuttid"
      ? `${buildTuttidBuiltinEnsureCommand(pnpmCommand, {
          forceGenerate: forceBuiltinGenerate
        })} `
      : "";

  return {
    key: `test:go:${sanitizeLaneKey(moduleRoot)}`,
    label: `test:go (${moduleRoot})`,
    serialGroup:
      moduleRoot === "services/tuttid" ? "tuttid-builtin-assets" : undefined,
    command: [
      "bash",
      "-lc",
      `${builtinEnsure}cd ${shellQuote(moduleRoot)} && go test ${targetList}`
    ]
  };
}

export function buildPackageTestCommand({
  baseRef,
  fileExists = existsSync,
  packageFiles,
  packageInfo,
  pnpmCommand
}) {
  const changedTests = packageFiles.filter(
    (file) => isTestFile(file) && fileExists(file)
  );
  const changedSource = packageFiles.filter(
    (file) => isLintableCodeFile(file) && !isTestFile(file)
  );
  const testScript = packageInfo.scripts.test;
  const vitestInvocation = resolveVitestInvocation(testScript);

  if (changedTests.length > 0) {
    if (vitestInvocation) {
      return [
        ...pnpmCommandPrefix(pnpmCommand),
        "--filter",
        packageInfo.name,
        "exec",
        "vitest",
        ...vitestInvocation,
        ...changedTests.map((file) =>
          relative(packageInfo.root, file).replaceAll("\\", "/")
        )
      ];
    }

    if (isVitestScript(testScript)) {
      return [
        ...pnpmCommandPrefix(pnpmCommand),
        "--filter",
        packageInfo.name,
        "test"
      ];
    }

    return [
      ...pnpmCommandPrefix(pnpmCommand),
      "--filter",
      packageInfo.name,
      "test",
      "--",
      ...changedTests.map((file) =>
        relative(packageInfo.root, file).replaceAll("\\", "/")
      )
    ];
  }

  if (changedSource.length > 0) {
    if (vitestInvocation) {
      return [
        ...pnpmCommandPrefix(pnpmCommand),
        "--filter",
        packageInfo.name,
        "exec",
        "vitest",
        ...vitestInvocation,
        "--changed",
        baseRef
      ];
    }

    return [
      ...pnpmCommandPrefix(pnpmCommand),
      "--filter",
      packageInfo.name,
      "test"
    ];
  }

  if (packageFiles.some(isTestFile)) {
    return null;
  }

  return [
    ...pnpmCommandPrefix(pnpmCommand),
    "--filter",
    packageInfo.name,
    "test"
  ];
}

function pnpmCommandPrefix(pnpmCommand) {
  return Array.isArray(pnpmCommand) ? pnpmCommand : [pnpmCommand];
}

function isVitestScript(testScript) {
  return typeof testScript === "string" && /\bvitest\b/u.test(testScript);
}

function resolveVitestInvocation(testScript) {
  if (typeof testScript !== "string") {
    return null;
  }

  const trimmedScript = testScript.trim();
  if (
    !/^vitest(?:\s|$)/u.test(trimmedScript) ||
    /(?:&&|\|\||[;|&<>])/u.test(trimmedScript)
  ) {
    return null;
  }

  const args = trimmedScript.split(/\s+/u).slice(1);
  return args.length > 0 ? args : ["run"];
}

function buildTuttidBuiltinEnsureCommand(pnpmCommand, { forceGenerate }) {
  if (forceGenerate) {
    return `${pnpmCommand} generate:builtin-apps &&`;
  }
  return `(${pnpmCommand} --filter @tutti-os/builtin-tutti-onboarding package:builtin:check || ${pnpmCommand} generate:builtin-apps) &&`;
}

function goPackagePattern(moduleRoot, file) {
  const normalized = file.replaceAll("\\", "/");
  const packageDir = dirname(normalized);
  const relativeDir = relative(moduleRoot, packageDir).replaceAll("\\", "/");
  return relativeDir === "" || relativeDir === "." ? "." : `./${relativeDir}`;
}

function addGoTarget(targetsByModule, moduleRoot, pattern) {
  if (!targetsByModule.has(moduleRoot)) {
    targetsByModule.set(moduleRoot, new Set());
  }
  const targets = targetsByModule.get(moduleRoot);
  if (pattern === "./...") {
    targets.clear();
    targets.add(pattern);
  } else if (!targets.has("./...")) {
    targets.add(pattern);
  }
}

function sanitizeLaneKey(value) {
  return value.replaceAll("/", "-");
}

function isLintableCodeFile(file) {
  return /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(file);
}

function isTestFile(file) {
  return /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file);
}

export function isGlobalGoValidationRelevant(file) {
  const normalized = file.replaceAll("\\", "/");
  return (
    GLOBAL_GO_VALIDATION_FILES.has(normalized) ||
    normalized.startsWith("services/tuttid/.golangci")
  );
}

export function isGoValidationRelevant(file) {
  const normalized = file.replaceAll("\\", "/");
  return (
    normalized.endsWith(".go") ||
    /(?:^|\/)go\.(?:mod|sum)$/u.test(normalized) ||
    isGlobalGoValidationRelevant(normalized)
  );
}
