import { dirname, join, relative } from "node:path";

const GO_MODULE_ROOTS = [
  "apps/cli",
  "packages/agent/daemon",
  "packages/appcli/core",
  "packages/workbench/service",
  "packages/workspace/files",
  "services/tuttid"
].sort((left, right) => right.length - left.length);

const GOLANGCI_CONFIG_RELATIVE_PATH = join(
  "services",
  "tuttid",
  ".golangci.yml"
);

export function resolveGoModuleRoot(file) {
  const normalized = file.replaceAll("\\", "/");
  for (const moduleRoot of GO_MODULE_ROOTS) {
    if (normalized === moduleRoot || normalized.startsWith(`${moduleRoot}/`)) {
      return moduleRoot;
    }
  }
  return null;
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

export function resolveGoValidationTargets(changedFiles) {
  const goFiles = changedFiles.filter(isGoValidationRelevant);
  if (goFiles.length === 0) {
    return null;
  }

  const lintByModule = new Map();
  const testByModule = new Map();

  for (const file of goFiles) {
    const moduleRoot = resolveGoModuleRoot(file);
    if (!moduleRoot) {
      continue;
    }

    if (/(?:^|\/)go\.(?:mod|sum)$/u.test(file)) {
      addGoTarget(lintByModule, moduleRoot, "./...");
      addGoTarget(testByModule, moduleRoot, "./...");
      continue;
    }

    if (!file.endsWith(".go")) {
      continue;
    }

    const packagePattern = goPackagePattern(moduleRoot, file);
    addGoTarget(lintByModule, moduleRoot, packagePattern);
    addGoTarget(testByModule, moduleRoot, `${packagePattern}/...`);
  }

  if (lintByModule.size === 0 && testByModule.size === 0) {
    return null;
  }

  return { lintByModule, testByModule };
}

export function buildGoLintLane({
  moduleRoot,
  targets,
  workspaceRoot,
  shellQuote
}) {
  const golangciConfigPath = join(workspaceRoot, GOLANGCI_CONFIG_RELATIVE_PATH);
  const targetList = Array.from(targets).sort().join(" ");
  return {
    key: `lint:go:${sanitizeLaneKey(moduleRoot)}`,
    label: `lint:go (${moduleRoot})`,
    command: [
      "bash",
      "-lc",
      `cd ${shellQuote(moduleRoot)} && golangci-lint run --config ${shellQuote(golangciConfigPath)} ${targetList}`
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
    command: [
      "bash",
      "-lc",
      `${builtinEnsure}cd ${shellQuote(moduleRoot)} && go test ${targetList}`
    ]
  };
}

export function buildPackageTestCommand({
  baseRef,
  packageFiles,
  packageInfo,
  pnpmCommand
}) {
  const changedTests = packageFiles.filter(isTestFile);
  const changedSource = packageFiles.filter(
    (file) => isLintableCodeFile(file) && !isTestFile(file)
  );
  const testScript = packageInfo.scripts.test;
  const vitestInvocation = resolveVitestInvocation(testScript);

  if (changedTests.length > 0) {
    if (vitestInvocation) {
      return [
        pnpmCommand,
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
      return [pnpmCommand, "--filter", packageInfo.name, "test"];
    }

    return [
      pnpmCommand,
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
        pnpmCommand,
        "--filter",
        packageInfo.name,
        "exec",
        "vitest",
        ...vitestInvocation,
        "--changed",
        baseRef
      ];
    }

    return [pnpmCommand, "--filter", packageInfo.name, "test"];
  }

  return [pnpmCommand, "--filter", packageInfo.name, "test"];
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
  targetsByModule.get(moduleRoot).add(pattern);
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

function isGoValidationRelevant(file) {
  return file.endsWith(".go") || /(?:^|\/)go\.(?:mod|sum)$/u.test(file);
}
