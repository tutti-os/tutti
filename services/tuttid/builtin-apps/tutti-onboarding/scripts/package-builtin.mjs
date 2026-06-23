import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const appDir = path.resolve(path.dirname(scriptPath), "..");
const repoRoot = path.resolve(appDir, "../../../..");
const builtinAppsDir = path.resolve(appDir, "..");
const packageSourceDir = path.join(appDir, "tutti-package");
const packageRoot = path.join(appDir, "build", "package");
const generatedDir = path.join(builtinAppsDir, "generated", "tutti-onboarding");
const lockDir = path.join(
  repoRoot,
  ".tmp",
  "builtin-apps",
  "tutti-onboarding-package.lock"
);
const lockOwnerPath = path.join(lockDir, "owner.json");
const staleLockMs = 10 * 60 * 1000;
const requiredPackageFiles = ["tutti.app.json", "AGENTS.md", "bootstrap.sh"];
const cliSegmentPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const defaultCliHandlerTimeoutMs = 30000;
const minCliHandlerTimeoutMs = 1000;
const maxCliHandlerTimeoutMs = 600000;

const args = parseArgs();

packageBuiltin({ checkOnly: args.check }).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = { buildOnly: false, check: false };
  for (const arg of argv) {
    if (arg === "--build-only") {
      parsed.buildOnly = true;
      continue;
    }
    if (arg === "--check") {
      parsed.check = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

async function packageBuiltin({ checkOnly = false } = {}) {
  if (args.buildOnly) {
    return await withPackageLock(runViteBuild);
  }
  if (checkOnly) {
    return await withPackageLock(async () => {
      const manifest = await readJson(
        path.join(packageSourceDir, "tutti.app.json")
      );
      const zipPath = generatedZipPath(manifest);
      await access(zipPath);
      await validatePackageRoot(packageRoot);
      console.log(`Validated ${zipPath}`);
      return zipPath;
    });
  }

  return await withPackageLock(async () => {
    await runViteBuild();

    const manifest = await readJson(
      path.join(packageSourceDir, "tutti.app.json")
    );
    const zipPath = generatedZipPath(manifest);
    await writePackageFiles(manifest);
    await validatePackageRoot(packageRoot);
    await mkdir(generatedDir, { recursive: true });
    await rm(zipPath, { force: true });
    await run("zip", ["-qry", zipPath, "."], { cwd: packageRoot });
    console.log(`Created ${zipPath}`);
    return zipPath;
  });
}

async function withPackageLock(callback) {
  const lockToken = randomUUID();
  await mkdir(path.dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(
        lockOwnerPath,
        `${JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            pid: process.pid,
            token: lockToken
          },
          null,
          2
        )}\n`
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const staleLockOwner = await readStaleLockOwner();
      if (staleLockOwner !== null) {
        await removeStaleLock(staleLockOwner);
        continue;
      }
      await sleep(250);
    }
  }
  try {
    return await callback();
  } finally {
    await removeLockIfOwnedBy(lockToken);
  }
}

async function readStaleLockOwner() {
  let info;
  try {
    info = await stat(lockDir);
  } catch {
    return { mtimeMs: 0, token: "" };
  }

  try {
    const owner = JSON.parse(await readFile(lockOwnerPath, "utf8"));
    if (Number.isInteger(owner.pid) && isProcessAlive(owner.pid)) {
      return null;
    }
    return {
      mtimeMs: info.mtimeMs,
      token: typeof owner.token === "string" ? owner.token : ""
    };
  } catch {
    return Date.now() - info.mtimeMs > staleLockMs
      ? { mtimeMs: info.mtimeMs, token: "" }
      : null;
  }
}

async function removeStaleLock(owner) {
  if (owner.token !== "") {
    await removeLockIfOwnedBy(owner.token);
    return;
  }
  try {
    const info = await stat(lockDir);
    if (info.mtimeMs !== owner.mtimeMs) {
      return;
    }
  } catch {
    return;
  }
  await rm(lockDir, { force: true, recursive: true });
}

async function removeLockIfOwnedBy(lockToken) {
  try {
    const owner = JSON.parse(await readFile(lockOwnerPath, "utf8"));
    if (owner.token !== lockToken) {
      return;
    }
  } catch {
    if (lockToken !== "") {
      return;
    }
  }
  await rm(lockDir, { force: true, recursive: true });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runViteBuild() {
  await run("pnpm", ["exec", "vite", "build"], { cwd: appDir });
}

function generatedZipPath(manifest) {
  const appID = String(manifest.appId ?? "").trim();
  const version = String(manifest.version ?? "").trim();
  if (!appID || !version) {
    throw new Error("tutti.app.json must define appId and version.");
  }
  return path.join(generatedDir, `${appID}-${version}.zip`);
}

async function writePackageFiles(manifest) {
  await rm(packageRoot, { force: true, recursive: true });
  await mkdir(packageRoot, { recursive: true });

  await writeFile(
    path.join(packageRoot, "tutti.app.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await cp(
    path.join(packageSourceDir, "AGENTS.md"),
    path.join(packageRoot, "AGENTS.md")
  );
  await cp(
    path.join(packageSourceDir, "bootstrap.sh"),
    path.join(packageRoot, "bootstrap.sh")
  );
  await chmod(path.join(packageRoot, "bootstrap.sh"), 0o755);
  await copyManifestIcon(manifest);
  await copyManifestLocalizations(manifest);
  await copyCliManifest(manifest);
  await cp(
    path.join(appDir, "dist", "client"),
    path.join(packageRoot, "dist"),
    {
      recursive: true
    }
  );
  await buildStandaloneServers();
  await writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`
  );
}

async function copyManifestIcon(manifest) {
  const iconSrc = manifest.icon?.src;
  if (!iconSrc) {
    return;
  }
  await cp(
    path.join(packageSourceDir, iconSrc),
    path.join(packageRoot, iconSrc)
  );
}

async function copyManifestLocalizations(manifest) {
  for (const locale of manifest.localizationInfo?.additionalLocales ?? []) {
    if (!locale.file) {
      continue;
    }
    const targetPath = path.join(packageRoot, locale.file);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await cp(path.join(packageSourceDir, locale.file), targetPath);
  }
}

async function copyCliManifest(manifest) {
  const cliManifestPath = manifest.cli?.manifest;
  if (!cliManifestPath) {
    return;
  }
  validatePackageRelativePath(cliManifestPath, "cli.manifest");

  const sourcePath = path.join(packageSourceDir, cliManifestPath);
  const targetPath = path.join(packageRoot, cliManifestPath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath);

  const cliManifest = await readJson(sourcePath);
  const documentationFile = cliManifest.documentation?.file;
  if (!documentationFile) {
    return;
  }
  validatePackageRelativePath(documentationFile, "documentation.file");
  const documentationTarget = path.join(packageRoot, documentationFile);
  await mkdir(path.dirname(documentationTarget), { recursive: true });
  await cp(path.join(packageSourceDir, documentationFile), documentationTarget);
}

async function buildStandaloneServers() {
  const sourcePath = path.join(packageSourceDir, "server.go");
  await access(sourcePath);
  for (const target of ["darwin-arm64", "darwin-amd64"]) {
    const [goos, goarch] = target.split("-");
    const targetDir = path.join(packageRoot, "bin", target);
    await mkdir(targetDir, { recursive: true });
    await run(
      "go",
      [
        "build",
        "-trimpath",
        "-ldflags",
        "-s -w",
        "-o",
        path.join(targetDir, "tutti-onboarding-server"),
        sourcePath
      ],
      {
        cwd: appDir,
        env: {
          ...process.env,
          CGO_ENABLED: "0",
          GOARCH: goarch,
          GOOS: goos
        }
      }
    );
  }
}

async function validatePackageRoot(root) {
  const manifest = await readJson(path.join(root, "tutti.app.json"));
  for (const relativePath of requiredPackageFiles) {
    await access(path.join(root, relativePath));
  }
  if (manifest.schemaVersion !== "tutti.app.manifest.v1") {
    throw new Error(
      "tutti.app.json must use schemaVersion tutti.app.manifest.v1."
    );
  }
  if (!manifest.appId || !manifest.version || !manifest.runtime?.bootstrap) {
    throw new Error(
      "tutti.app.json must define appId, version, and runtime.bootstrap."
    );
  }
  if (manifest.runtime?.profile !== "standalone") {
    throw new Error("builtin onboarding must use standalone runtime profile.");
  }
  if (manifest.cli?.manifest) {
    validatePackageRelativePath(manifest.cli.manifest, "cli.manifest");
    const cliManifest = await readJson(path.join(root, manifest.cli.manifest));
    validateCliManifest(cliManifest);
    const documentationFile = cliManifest.documentation?.file;
    if (documentationFile) {
      validatePackageRelativePath(documentationFile, "documentation.file");
      await access(path.join(root, documentationFile));
    }
  }

  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  if (agents.trim().length === 0) {
    throw new Error("AGENTS.md must be non-empty.");
  }
  const bootstrapStat = await stat(path.join(root, "bootstrap.sh"));
  if ((bootstrapStat.mode & 0o111) === 0) {
    throw new Error("bootstrap.sh must be executable.");
  }
  await assertNoSymlinks(root);
}

async function assertNoSymlinks(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(
        `Package contains symlink: ${path.relative(root, entryPath)}`
      );
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(entryPath);
    }
  }
}

function validatePackageRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`tutti.cli.json ${label} is required.`);
  }
  if (path.isAbsolute(value) || value.startsWith("\\")) {
    throw new Error(`tutti.cli.json ${label} must be a relative package path.`);
  }
  for (const part of value.split(/[\\/]/)) {
    if (part === "..") {
      throw new Error(
        `tutti.cli.json ${label} must not contain parent path segments.`
      );
    }
  }
}

function validateCliSegment(value, label) {
  if (typeof value !== "string" || !cliSegmentPattern.test(value.trim())) {
    throw new Error(
      `tutti.cli.json ${label} must contain lowercase letters, numbers, and hyphen only.`
    );
  }
}

function validateCliInputSchema(schema, label) {
  if (!schema) {
    return;
  }
  if (schema.type !== "object") {
    throw new Error(`tutti.cli.json ${label}.type must be object.`);
  }
  if (!schema.properties || typeof schema.properties !== "object") {
    throw new Error(`tutti.cli.json ${label}.properties is required.`);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    validateCliSegment(name, `${label}.properties`);
    if (!property || typeof property !== "object") {
      throw new Error(
        `tutti.cli.json ${label}.properties.${name} must be an object.`
      );
    }
    if (!["string", "boolean", "integer"].includes(property.type)) {
      throw new Error(
        `tutti.cli.json ${label}.properties.${name}.type must be string, boolean, or integer.`
      );
    }
  }
}

function validateCliOutput(output, label) {
  if (!output || !["json", "table"].includes(output.defaultMode)) {
    throw new Error(
      `tutti.cli.json ${label}.defaultMode must be json or table.`
    );
  }
  if (output.defaultMode === "json" && output.json !== true) {
    throw new Error(
      `tutti.cli.json ${label}.json must be true when defaultMode is json.`
    );
  }
  if (
    output.defaultMode === "table" &&
    (!output.table ||
      !Array.isArray(output.table.columns) ||
      output.table.columns.length === 0)
  ) {
    throw new Error(
      `tutti.cli.json ${label}.table.columns is required when defaultMode is table.`
    );
  }
}

function validateCliHandler(handler, label) {
  if (handler?.kind !== "http") {
    throw new Error(`tutti.cli.json ${label}.kind must be http.`);
  }
  if (handler.method !== "POST") {
    throw new Error(`tutti.cli.json ${label}.method must be POST.`);
  }
  if (
    typeof handler.path !== "string" ||
    !handler.path.startsWith("/tutti/cli/")
  ) {
    throw new Error(
      `tutti.cli.json ${label}.path must start with /tutti/cli/.`
    );
  }
  const timeoutMs = normalizeCliHandlerTimeoutMs(
    handler.timeoutMs,
    `${label}.timeoutMs`
  );
  if (
    timeoutMs < minCliHandlerTimeoutMs ||
    timeoutMs > maxCliHandlerTimeoutMs
  ) {
    throw new Error(
      `tutti.cli.json ${label}.timeoutMs must be between ${minCliHandlerTimeoutMs} and ${maxCliHandlerTimeoutMs}.`
    );
  }
}

function normalizeCliHandlerTimeoutMs(value, label) {
  if (value === undefined || value === null || value === 0) {
    return defaultCliHandlerTimeoutMs;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`tutti.cli.json ${label} must be an integer.`);
  }
  return value;
}

function validateCliManifest(cliManifest) {
  if (cliManifest.schemaVersion !== "tutti.app.cli.v1") {
    throw new Error("tutti.cli.json must use schemaVersion tutti.app.cli.v1.");
  }
  validateCliSegment(cliManifest.scope, "scope");
  if (
    !Array.isArray(cliManifest.commands) ||
    cliManifest.commands.length === 0
  ) {
    throw new Error("tutti.cli.json commands must be a non-empty array.");
  }
  const seenPaths = new Set();
  for (const [index, command] of cliManifest.commands.entries()) {
    const label = `commands[${index}]`;
    if (!Array.isArray(command.path) || command.path.length === 0) {
      throw new Error(`tutti.cli.json ${label}.path is required.`);
    }
    for (const [segmentIndex, segment] of command.path.entries()) {
      validateCliSegment(segment, `${label}.path[${segmentIndex}]`);
    }
    const pathKey = command.path.join(".");
    if (seenPaths.has(pathKey)) {
      throw new Error(`tutti.cli.json command path ${pathKey} is duplicated.`);
    }
    seenPaths.add(pathKey);
    validateCliInputSchema(command.inputSchema, `${label}.inputSchema`);
    validateCliOutput(command.output, `${label}.output`);
    validateCliHandler(command.handler, `${label}.handler`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? appDir,
      env: options.env ?? process.env,
      shell: false,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} exited with code ${code}`)
      );
    });
  });
}
