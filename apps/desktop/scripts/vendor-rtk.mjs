import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const lock = JSON.parse(
  await readFile(join(repoRoot, "config/tutti.app-runtime.lock.json"), "utf8")
);
const rtk = lock.rtk;
if (!rtk?.version || !rtk?.license || !rtk?.artifacts) {
  throw new Error(
    "config/tutti.app-runtime.lock.json has no RTK artifact catalog"
  );
}

const platforms = parsePlatformArguments(process.argv.slice(2));
const outputRoot = resolve(
  process.env.TUTTI_RTK_STAGING_DIR?.trim() ||
    join(repoRoot, "apps/desktop/build/rtk")
);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const extracted = new Map();
const extractionRoots = [];
try {
  for (const platform of platforms) {
    const artifact = rtk.artifacts[platform];
    if (!artifact)
      throw new Error(`RTK artifact catalog does not contain ${platform}`);
    const archive = await resolveVerifiedDownload(artifact, "archive");
    const extractionRoot = await mkdtemp(join(tmpdir(), "tutti-rtk-extract-"));
    extractionRoots.push(extractionRoot);
    await extractArchive(archive, extractionRoot);
    const executable = await findFile(extractionRoot, artifact.executable);
    if (!executable) {
      throw new Error(
        `${basename(archive)} does not contain ${artifact.executable}`
      );
    }
    extracted.set(platform, executable);
  }

  const outputName = platforms[0].startsWith("windows-") ? "rtk.exe" : "rtk";
  const outputExecutable = join(outputRoot, outputName);
  if (platforms.length === 1) {
    await copyFile(extracted.get(platforms[0]), outputExecutable);
  } else {
    const expected = new Set(["darwin-arm64", "darwin-amd64"]);
    if (
      platforms.length !== expected.size ||
      platforms.some((value) => !expected.has(value))
    ) {
      throw new Error(
        "multiple RTK artifacts are supported only for macOS universal packaging"
      );
    }
    await execFileAsync("lipo", [
      "-create",
      extracted.get("darwin-arm64"),
      extracted.get("darwin-amd64"),
      "-output",
      outputExecutable
    ]);
    await execFileAsync("lipo", [
      outputExecutable,
      "-verify_arch",
      "arm64",
      "x86_64"
    ]);
  }
  await chmod(outputExecutable, 0o755);

  const license = await resolveVerifiedDownload(rtk.license, "license");
  await copyFile(license, join(outputRoot, "LICENSE"));
  await writeFile(
    join(outputRoot, "THIRD_PARTY_NOTICES.md"),
    `# RTK third-party notice

Tutti packages an unmodified RTK ${rtk.version} executable for Session-scoped
Agent tool-output compression and the Tutti integrated terminal.

- Project: https://github.com/rtk-ai/rtk
- Release: https://github.com/rtk-ai/rtk/releases/tag/v${rtk.version}
- License: Apache-2.0; see LICENSE in this directory
`,
    "utf8"
  );
  await writeFile(
    join(outputRoot, "runtime.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tutti.rtk.v1",
        version: rtk.version,
        executable: outputName,
        platforms
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const { stdout } = await execFileAsync(outputExecutable, ["--version"]);
  if (stdout.trim() !== `rtk ${rtk.version}`) {
    throw new Error(`bundled RTK version mismatch: ${stdout.trim()}`);
  }
} finally {
  await Promise.all(
    extractionRoots.map((path) => rm(path, { recursive: true, force: true }))
  );
}

async function extractArchive(archive, destination) {
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }",
      archive,
      destination
    ]);
    return;
  }
  await execFileAsync("tar", ["-xf", archive, "-C", destination]);
}

function parsePlatformArguments(args) {
  const values = args
    .filter((argument) => argument.startsWith("--platform="))
    .flatMap((argument) => argument.slice("--platform=".length).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length !== args.length) {
    throw new Error(
      "provide one or more --platform=<runtime-platform> arguments"
    );
  }
  return [...new Set(values)];
}

async function resolveVerifiedDownload(artifact, kind) {
  const cacheRoot = join(tmpdir(), "tutti-build-cache", "rtk", rtk.version);
  const path = join(cacheRoot, basename(new URL(artifact.url).pathname));
  await mkdir(cacheRoot, { recursive: true });
  try {
    await verifyFile(path, artifact, kind);
    return path;
  } catch {
    await rm(path, { force: true });
  }
  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok)
    throw new Error(`download ${artifact.url}: HTTP ${response.status}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, Buffer.from(await response.arrayBuffer()), {
    flag: "wx"
  });
  try {
    await verifyFile(temporary, artifact, kind);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

async function verifyFile(path, artifact, kind) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== artifact.sizeBytes) {
    throw new Error(`RTK ${kind} size mismatch for ${path}`);
  }
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(`RTK ${kind} checksum mismatch for ${path}`);
  }
}

async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = await findFile(path, name);
      if (nested) return nested;
    }
  }
  return null;
}
