import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const nodeModulesDirectory = join(workspaceRoot, "node_modules");
const nodeVersionFile = join(workspaceRoot, ".node-version");
const packageJsonPath = join(workspaceRoot, "package.json");
const goModPath = join(workspaceRoot, "services", "tuttid", "go.mod");
const golangciVersionFile = join(
  workspaceRoot,
  "services",
  "tuttid",
  ".golangci-lint-version"
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const minimumNodeMajor = Number.parseInt(
  readFileSync(nodeVersionFile, "utf8").trim(),
  10
);
const pinnedPnpmVersion = parsePnpmVersion(packageJson.packageManager);
const requiredGoPrefix = parseGoVersionPrefix(readFileSync(goModPath, "utf8"));
const pinnedGolangciVersion = readFileSync(golangciVersionFile, "utf8").trim();
const argumentsList = process.argv.slice(2);
const onlyCheck = parseOnlyCheck(argumentsList);
const installTarget = parseInstallTarget(argumentsList);

if (installTarget === "golangci-lint") {
  installGolangciLint();
}

const checks = buildChecks();

const failedChecks = checks.filter((check) => !check.ok);

console.log("tutti developer setup");
for (const check of checks) {
  console.log(
    `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.ok ? check.success : check.failure}`
  );
}

if (failedChecks.length > 0) {
  console.log("");
  console.log("recommended next steps:");
  if (onlyCheck === "golangci-lint") {
    console.log("1. pnpm install:golangci-lint");
    console.log(
      "2. Ensure `$(go env GOPATH)/bin` is on your PATH, then rerun `pnpm check:golangci-version`."
    );
  } else {
    console.log(
      "1. Use Node.js from `.node-version` and pnpm from `packageManager`."
    );
    console.log("2. Install Go matching `services/tuttid/go.mod`.");
    console.log("3. Run `pnpm install`.");
    console.log("4. Run `pnpm install:golangci-lint`.");
    console.log(
      "5. Ensure `$(go env GOPATH)/bin` is on your PATH, then rerun `pnpm setup:dev`."
    );
  }
  process.exitCode = 1;
} else {
  console.log("");
  if (onlyCheck === "golangci-lint") {
    console.log("golangci-lint version matches the repository pin.");
  } else {
    console.log(
      "environment looks ready for `pnpm lint`, `pnpm typecheck`, and `pnpm check:full`."
    );
  }
}

function buildChecks() {
  const allChecks = [
    {
      name: "node",
      ...checkNode()
    },
    {
      name: "pnpm",
      ...checkPnpm()
    },
    {
      name: "go",
      ...checkGo()
    },
    {
      name: "workspace dependencies",
      ok: existsSync(nodeModulesDirectory),
      success: "workspace dependencies look installed",
      failure: "run `pnpm install`"
    },
    {
      name: "golangci-lint",
      ...checkGolangciLint()
    }
  ];

  if (onlyCheck === null) {
    return allChecks;
  }

  return allChecks.filter((check) => check.name === onlyCheck);
}

function checkNode() {
  const currentMajor = Number.parseInt(
    process.versions.node.split(".")[0] ?? "",
    10
  );
  const ok = Number.isFinite(currentMajor) && currentMajor >= minimumNodeMajor;

  return {
    ok,
    success: `found ${process.version}`,
    failure: `expected Node.js ${minimumNodeMajor} or newer, found ${process.version}`
  };
}

function checkPnpm() {
  const result = spawnSync("pnpm", ["--version"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });

  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      success: "",
      failure: `install pnpm ${pinnedPnpmVersion}`
    };
  }

  const version = result.stdout.trim();
  return {
    ok: version === pinnedPnpmVersion,
    success: `found ${version}`,
    failure: `expected pnpm ${pinnedPnpmVersion}, found ${version || "unknown version"}`
  };
}

function checkGo() {
  const result = spawnSync("go", ["version"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });

  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      success: "",
      failure: `install Go ${requiredGoPrefix.replace("go", "")}.x`
    };
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: output.includes(requiredGoPrefix),
    success: output,
    failure: `expected ${requiredGoPrefix}.x, found \`${output || "unknown version"}\``
  };
}

function checkGolangciLint() {
  const result = spawnSync("golangci-lint", ["version"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });

  if (result.error?.code === "ENOENT") {
    return {
      ok: false,
      success: "",
      failure: `install ${pinnedGolangciVersion} and add it to PATH`
    };
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const normalizedExpected = pinnedGolangciVersion.replace(/^v/, "");

  if (!output.includes(normalizedExpected)) {
    return {
      ok: false,
      success: "",
      failure: `expected ${pinnedGolangciVersion}, found \`${output.trim() || "unknown version"}\``
    };
  }

  return {
    ok: true,
    success: `found ${pinnedGolangciVersion}`,
    failure: ""
  };
}

function parseOnlyCheck(argumentsList) {
  const onlyArgument = argumentsList.find((argument) =>
    argument.startsWith("--only=")
  );
  if (!onlyArgument) {
    return null;
  }

  const value = onlyArgument.slice("--only=".length);
  if (
    ["node", "pnpm", "go", "workspace dependencies", "golangci-lint"].includes(
      value
    )
  ) {
    return value;
  }

  throw new Error(`unsupported setup-dev check target: ${value}`);
}

function parseInstallTarget(argumentsList) {
  const installArgument = argumentsList.find((argument) =>
    argument.startsWith("--install=")
  );
  if (!installArgument) {
    return null;
  }

  const value = installArgument.slice("--install=".length);
  if (value === "golangci-lint") {
    return value;
  }

  throw new Error(`unsupported setup-dev install target: ${value}`);
}

function parsePnpmVersion(packageManager) {
  const match = /^pnpm@(.+)$/.exec(packageManager);
  if (!match) {
    throw new Error(`unsupported packageManager value: ${packageManager}`);
  }
  // corepack may pin an integrity suffix (pnpm@x.y.z+sha512....) that
  // `pnpm --version` never reports, so compare on the bare version only.
  return match[1].split("+")[0];
}

function parseGoVersionPrefix(goMod) {
  const match = /^go\s+(\d+\.\d+)(?:\.\d+)?$/m.exec(goMod);
  if (!match) {
    throw new Error("unable to parse Go version from services/tuttid/go.mod");
  }
  return `go${match[1]}`;
}

function installGolangciLint() {
  const goPathResult = spawnSync("go", ["env", "GOPATH"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });

  if (goPathResult.error?.code === "ENOENT" || goPathResult.status !== 0) {
    console.error(
      "Go is required to resolve GOPATH before installing golangci-lint."
    );
    process.exit(1);
  }

  const goPath = goPathResult.stdout.trim();
  const installDir = join(goPath, "bin");
  const command = `curl -sSfL https://golangci-lint.run/install.sh | sh -s -- -b "${installDir}" "${pinnedGolangciVersion}"`;

  console.log(
    `Installing golangci-lint ${pinnedGolangciVersion} to ${installDir}`
  );
  const result = spawnSync("sh", ["-c", command], {
    cwd: workspaceRoot,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
