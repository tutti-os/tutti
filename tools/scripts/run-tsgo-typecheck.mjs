import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const packageRoot = resolvePackageRoot();
const tsconfigPath = join(packageRoot, "tsconfig.json");
const tsgoCommand = process.platform === "win32" ? "tsgo.cmd" : "tsgo";
const tsgoPath = join(workspaceRoot, "node_modules", ".bin", tsgoCommand);
const forwardedArgs = removePackageRootOption(process.argv.slice(2));

if (!existsSync(tsconfigPath)) {
  console.error(
    `typecheck expected ${relative(workspaceRoot, tsconfigPath)} to exist`
  );
  process.exit(1);
}

const packageKey = relative(workspaceRoot, packageRoot).replaceAll("\\", "/");
const tsbuildInfoDirectory = join(workspaceRoot, ".tmp", "tsbuildinfo");
const tsbuildInfoPath = join(
  tsbuildInfoDirectory,
  `${sanitizeFileName(packageKey)}.tsbuildinfo`
);
mkdirSync(tsbuildInfoDirectory, { recursive: true });

const child = spawn(
  tsgoPath,
  [
    "--noEmit",
    "--incremental",
    "--tsBuildInfoFile",
    tsbuildInfoPath,
    "-p",
    "tsconfig.json",
    ...forwardedArgs
  ],
  {
    cwd: packageRoot,
    env: process.env,
    stdio: "inherit"
  }
);

child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on("close", (code) => {
  process.exit(typeof code === "number" ? code : 1);
});

function sanitizeFileName(value) {
  return value.replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function resolvePackageRoot() {
  const packageRootOption = readOption("--package-root");
  if (packageRootOption === null) {
    return process.cwd();
  }
  return join(workspaceRoot, packageRootOption);
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  return process.argv[index + 1] ?? null;
}

function removePackageRootOption(args) {
  const index = args.indexOf("--package-root");
  if (index === -1) {
    return args;
  }
  return args.toSpliced(index, 2);
}
