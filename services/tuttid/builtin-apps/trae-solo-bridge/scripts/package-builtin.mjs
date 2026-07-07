import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const appDir = path.resolve(path.dirname(scriptPath), "..");
const builtinAppsDir = path.resolve(appDir, "..");
const packageSourceDir = path.join(appDir, "tutti-package");
const packageRoot = path.join(appDir, "build", "package");
const generatedDir = path.join(builtinAppsDir, "generated", "trae-solo-bridge");

const requiredPackageFiles = [
  "tutti.app.json",
  "AGENTS.md",
  "bootstrap.sh",
  "server.js",
  "devtools_send.js",
  "icon.svg"
];

const args = parseArgs();
packageBuiltin({ checkOnly: args.check }).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = { check: false };
  for (const arg of argv) {
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

async function packageBuiltin({ checkOnly = false } = {}) {
  const manifest = await readJson(
    path.join(packageSourceDir, "tutti.app.json")
  );
  const zipPath = generatedZipPath(manifest);
  if (checkOnly) {
    await access(zipPath);
    await validatePackageRoot(packageRoot);
    console.log(`Validated ${zipPath}`);
    return zipPath;
  }

  await writePackageFiles();
  await validatePackageRoot(packageRoot);
  await mkdir(generatedDir, { recursive: true });
  const tempZipPath = path.join(
    generatedDir,
    `.${path.basename(zipPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    await run("zip", ["-qry", tempZipPath, "."], { cwd: packageRoot });
    await rename(tempZipPath, zipPath);
  } finally {
    await rm(tempZipPath, { force: true });
  }
  console.log(`Created ${zipPath}`);
  return zipPath;
}

function generatedZipPath(manifest) {
  const appID = String(manifest.appId ?? "").trim();
  const version = String(manifest.version ?? "").trim();
  if (!appID || !version) {
    throw new Error("tutti.app.json must define appId and version.");
  }
  return path.join(generatedDir, `${appID}-${version}.zip`);
}

async function writePackageFiles() {
  await rm(packageRoot, { force: true, recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await copyDirectoryContents(packageSourceDir, packageRoot);
  await chmod(path.join(packageRoot, "bootstrap.sh"), 0o755);
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (source) => {
      const base = path.basename(source);
      return (
        base !== ".data" && base !== ".logs" && base !== ".tutti-trae-solo"
      );
    }
  });
}

async function validatePackageRoot(root) {
  for (const file of requiredPackageFiles) {
    await access(path.join(root, file));
  }
  const manifest = await readJson(path.join(root, "tutti.app.json"));
  if (manifest.schemaVersion !== "tutti.app.manifest.v1") {
    throw new Error(
      "tutti.app.json schemaVersion must be tutti.app.manifest.v1."
    );
  }
  if (manifest.appId !== "trae-solo-bridge") {
    throw new Error("tutti.app.json appId must be trae-solo-bridge.");
  }
  if (manifest.runtime?.bootstrap !== "bootstrap.sh") {
    throw new Error("tutti.app.json runtime.bootstrap must be bootstrap.sh.");
  }
  if (manifest.runtime?.profile !== "node-static") {
    throw new Error("tutti.app.json runtime.profile must be node-static.");
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`)
      );
    });
  });
}
