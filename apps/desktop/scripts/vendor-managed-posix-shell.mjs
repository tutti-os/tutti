import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const lockPath = join(repoRoot, "config/tutti.managed-posix-shell.lock.json");
const outputRoot = resolve(
  process.env.TUTTI_MANAGED_POSIX_SHELL_STAGING_DIR?.trim() ||
    join(repoRoot, "apps/desktop/build/managed-posix-shell")
);

const lock = JSON.parse(await readFile(lockPath, "utf8"));
if (lock.schemaVersion !== "tutti.managed-posix-shell-lock.v1") {
  throw new Error(
    `unsupported managed POSIX shell lock schema: ${lock.schemaVersion}`
  );
}

const platform = parsePlatformArgument(process.argv.slice(2));
const config = lock.platforms?.[platform];
if (!config) {
  throw new Error(`managed POSIX shell lock does not contain ${platform}`);
}
if (
  typeof config.executable !== "string" ||
  !config.runtimeFiles?.includes(config.executable)
) {
  throw new Error(
    `managed POSIX shell executable must be listed in runtimeFiles: ${config.executable}`
  );
}

function parsePlatformArgument(args) {
  const platformArgument = args.find((argument) =>
    argument.startsWith("--platform=")
  );
  if (!platformArgument) {
    throw new Error(
      "managed POSIX shell platform is required: --platform=<platform>"
    );
  }
  const platform = platformArgument.slice("--platform=".length).trim();
  if (!platform || args.length !== 1) {
    throw new Error(`invalid managed POSIX shell arguments: ${args.join(" ")}`);
  }
  return platform;
}

const archivePath = await resolveArchive(config);
const extractRoot = await mkdtemp(join(tmpdir(), "tutti-managed-posix-shell-"));
try {
  const selectedFiles = [...config.runtimeFiles, ...config.licenseFiles];
  extractArchive(archivePath, extractRoot, config.archiveRoot, selectedFiles);

  await rm(outputRoot, { recursive: true, force: true });
  for (const relativePath of selectedFiles) {
    const source = join(extractRoot, config.archiveRoot, relativePath);
    const target = join(outputRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }

  const runtimeFiles = [];
  for (const relativePath of config.runtimeFiles) {
    const target = join(outputRoot, relativePath);
    await access(target);
    runtimeFiles.push({
      path: relativePath.replaceAll("\\", "/"),
      sha256: await sha256File(target),
      sizeBytes: (await stat(target)).size
    });
  }
  await access(join(outputRoot, config.executable));
  await writeFile(
    join(outputRoot, "runtime.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tutti.managed-posix-shell.v1",
        platform,
        distribution: config.distribution,
        version: config.version,
        executable: config.executable,
        components: config.components,
        sourceArchive: basename(config.archiveUrl),
        sourceArchiveSha256: config.archiveSha256,
        files: runtimeFiles
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    join(outputRoot, "THIRD_PARTY_NOTICES.md"),
    renderThirdPartyNotices(config),
    "utf8"
  );
} finally {
  await rm(extractRoot, { recursive: true, force: true });
}

async function resolveArchive(config) {
  const override = process.env.TUTTI_MSYS2_BASE_ARCHIVE?.trim();
  if (override) {
    const path = resolve(override);
    await verifyArchive(path, config.archiveSha256);
    return path;
  }

  const cacheRoot = join(tmpdir(), "tutti-build-cache", "managed-posix-shell");
  const path = join(cacheRoot, basename(config.archiveUrl));
  await mkdir(cacheRoot, { recursive: true });
  try {
    await verifyArchive(path, config.archiveSha256);
    return path;
  } catch {
    await rm(path, { force: true });
  }

  const response = await fetch(config.archiveUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `download managed POSIX shell archive: HTTP ${response.status}`
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes);
  await verifyArchive(path, config.archiveSha256);
  return path;
}

async function verifyArchive(path, expectedSha256) {
  await access(path);
  const actualSha256 = await sha256File(path);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `managed POSIX shell archive checksum mismatch: got ${actualSha256}, want ${expectedSha256}`
    );
  }
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function extractArchive(archivePath, targetRoot, archiveRoot, relativePaths) {
  const archivePaths = relativePaths.map((path) => `${archiveRoot}/${path}`);
  const result = spawnSync(
    resolveTarCommand(),
    ["-xf", archivePath, "-C", targetRoot, ...archivePaths],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `extract managed POSIX shell archive: ${result.stderr || result.stdout || result.error}`
    );
  }
}

function resolveTarCommand() {
  if (process.platform !== "win32") {
    return "tar";
  }
  const systemRoot = process.env.SystemRoot?.trim();
  if (!systemRoot) {
    throw new Error(
      "extract managed POSIX shell archive: SystemRoot is unavailable"
    );
  }
  return join(systemRoot, "System32", "tar.exe");
}

function renderThirdPartyNotices(config) {
  const components = config.components
    .map(
      (component) =>
        `- ${component.name} ${component.version}: ${component.license}`
    )
    .join("\n");
  return `# Managed POSIX Shell third-party notices

The Windows managed POSIX shell runtime is assembled from the official MSYS2
base distribution ${config.version}. It contains unmodified copies of GNU Bash,
selected GNU coreutils programs, GNU libiconv/libintl runtime libraries, and the
MSYS2 POSIX runtime.

- Distribution: ${config.archiveUrl}
- Distribution SHA-256: ${config.archiveSha256}
- MSYS2 package sources: https://repo.msys2.org/msys/sources/
- GNU Bash source: https://www.gnu.org/software/bash/
- GNU coreutils source: https://www.gnu.org/software/coreutils/
- GNU libiconv source: https://www.gnu.org/software/libiconv/
- GNU gettext/libintl source: https://www.gnu.org/software/gettext/
- MSYS2 runtime source: https://github.com/msys2/msys2-runtime

Included component versions and declared package licenses:

${components}

The accompanying files under \`usr/share/doc/Cygwin\` contain the MSYS2/Cygwin
runtime notices and GPL text. Exact MSYS2 package metadata is retained under
\`var/lib/pacman/local\`. The upstream package sources and applicable license
texts must remain available with every released runtime version.
`;
}
