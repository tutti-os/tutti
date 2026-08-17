import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const lock = JSON.parse(
  await readFile(join(repoRoot, "config/tutti.mutagen.lock.json"), "utf8")
);
if (lock.schemaVersion !== "tutti.mutagen-lock.v1") {
  throw new Error(`unsupported Mutagen lock schema: ${lock.schemaVersion}`);
}

const platform = parsePlatformArgument(process.argv.slice(2));
const config = lock.platforms?.[platform];
if (!config) throw new Error(`Mutagen lock does not contain ${platform}`);
const outputRoot = resolve(
  process.env.TUTTI_MUTAGEN_STAGING_DIR?.trim() ||
    join(repoRoot, "apps/desktop/build/mutagen")
);
const archivePath = await resolveArchive(config);
const extractRoot = await mkdtemp(join(tmpdir(), "tutti-mutagen-"));

try {
  const archiveExecutable = listArchiveExecutable(
    archivePath,
    config.executable
  );
  extractArchiveEntry(archivePath, extractRoot, archiveExecutable);
  const extractedExecutable = join(
    extractRoot,
    ...archiveExecutable.split("/")
  );
  await access(extractedExecutable);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const executable = join(outputRoot, config.executable);
  await copyFile(extractedExecutable, executable);
  for (const license of config.licenseFiles) {
    await downloadVerifiedFile(
      license.url,
      license.sha256,
      join(outputRoot, license.name)
    );
  }
  await writeFile(
    join(outputRoot, "runtime.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tutti.mutagen.v1",
        platform,
        version: config.version,
        executable: config.executable,
        sourceArchive: basename(config.archiveUrl),
        sourceArchiveSha256: config.archiveSha256,
        executableSha256: await sha256File(executable),
        executableSizeBytes: (await stat(executable)).size
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(outputRoot, "THIRD_PARTY_NOTICES.md"),
    `# Mutagen third-party notices

Tutti includes an unmodified Mutagen ${config.version} executable from the
official release archive below for Windows auth-file synchronization.

- Source and release: https://github.com/mutagen-io/mutagen/tree/v${config.version}
- Release archive: ${config.archiveUrl}
- Release archive SHA-256: ${config.archiveSha256}

The upstream LICENSE states that official Mutagen release builds from v0.17
onward include SSPL-licensed code. The complete upstream LICENSE and SSPL text
are distributed beside this notice.
`,
    "utf8"
  );
} finally {
  await rm(extractRoot, { recursive: true, force: true });
}

function parsePlatformArgument(args) {
  const value = args.find((argument) => argument.startsWith("--platform="));
  if (!value) throw new Error("Mutagen platform is required");
  const platform = value.slice("--platform=".length).trim();
  if (!platform || args.length !== 1) {
    throw new Error(`invalid Mutagen arguments: ${args.join(" ")}`);
  }
  return platform;
}

async function resolveArchive(config) {
  const override = process.env.TUTTI_MUTAGEN_ARCHIVE?.trim();
  if (override) {
    const path = resolve(override);
    await verifyFile(path, config.archiveSha256, "Mutagen archive");
    return path;
  }
  const cacheRoot = join(tmpdir(), "tutti-build-cache", "mutagen");
  const path = join(cacheRoot, basename(config.archiveUrl));
  await mkdir(cacheRoot, { recursive: true });
  try {
    await verifyFile(path, config.archiveSha256, "Mutagen archive");
    return path;
  } catch {
    await rm(path, { force: true });
  }
  await downloadVerifiedFile(config.archiveUrl, config.archiveSha256, path);
  return path;
}

async function downloadVerifiedFile(url, expectedSha256, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `download checksum mismatch for ${url}: got ${actualSha256}, want ${expectedSha256}`
    );
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rm(target, { force: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function verifyFile(path, expectedSha256, label) {
  await access(path);
  const actualSha256 = await sha256File(path);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `${label} checksum mismatch: got ${actualSha256}, want ${expectedSha256}`
    );
  }
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function listArchiveExecutable(archivePath, executable) {
  const result = spawnSync(resolveTarCommand(), ["-tzf", archivePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `list Mutagen archive: ${result.stderr || result.stdout || result.error}`
    );
  }
  const matches = result.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\.\//u, ""))
    .filter((entry) => entry && basename(entry) === executable);
  if (matches.length !== 1) {
    throw new Error(
      `Mutagen archive must contain exactly one ${executable}, found ${matches.length}`
    );
  }
  const entry = matches[0];
  if (
    isAbsolute(entry) ||
    entry.split("/").some((part) => part === "" || part === "..")
  ) {
    throw new Error(`unsafe Mutagen archive entry: ${entry}`);
  }
  return entry;
}

function extractArchiveEntry(archivePath, targetRoot, entry) {
  const result = spawnSync(
    resolveTarCommand(),
    ["-xzf", archivePath, "-C", targetRoot, entry],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `extract Mutagen archive: ${result.stderr || result.stdout || result.error}`
    );
  }
}

function resolveTarCommand() {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) {
    throw new Error("extract Mutagen archive: SystemRoot is unavailable");
  }
  return join(systemRoot, "System32", "tar.exe");
}
