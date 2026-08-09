import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const defaults = JSON.parse(
  await readFile(join(repoRoot, "config/tutti.defaults.json"), "utf8")
);
const uv = defaults.agentRuntimeTools?.uv;
if (!uv?.version || !Array.isArray(uv.artifacts)) {
  throw new Error("config/tutti.defaults.json has no managed uv artifact catalog");
}

const platforms = parsePlatformArguments(process.argv.slice(2));
const outputRoot = resolve(
  process.env.TUTTI_UV_STAGING_DIR?.trim() ||
    join(repoRoot, "apps/desktop/build/managed-uv")
);
await rm(outputRoot, { recursive: true, force: true });

for (const platform of platforms) {
  const artifact = uv.artifacts.find((entry) => entry.platform === platform);
  if (!artifact) throw new Error(`managed uv catalog does not contain ${platform}`);
  const targetDir = join(outputRoot, platform, uv.version);
  const target = join(targetDir, basename(artifact.url));
  const source = await resolveArchive(artifact);
  await mkdir(targetDir, { recursive: true });
  await copyVerifiedArchive(source, target, artifact);
}

await writeFile(
  join(outputRoot, "THIRD_PARTY_NOTICES.md"),
  `# uv third-party notice

Tutti packages unmodified uv ${uv.version} release archives for offline Agent
Target setup. Each archive is selected from config/tutti.defaults.json and is
verified by its pinned byte size and SHA-256 before packaging and again before
extraction by tuttid.

- Project: https://github.com/astral-sh/uv
- Release: https://github.com/astral-sh/uv/releases/tag/${uv.version}
- Licenses: https://github.com/astral-sh/uv/tree/${uv.version}#license
`,
  "utf8"
);

function parsePlatformArguments(args) {
  const values = args
    .filter((argument) => argument.startsWith("--platform="))
    .flatMap((argument) => argument.slice("--platform=".length).split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.length !== args.length) {
    throw new Error("provide one or more --platform=<runtime-platform> arguments");
  }
  return [...new Set(values)];
}

async function resolveArchive(artifact) {
  const envKey = `TUTTI_UV_ARCHIVE_${artifact.platform.toUpperCase().replaceAll("-", "_")}`;
  const override = process.env[envKey]?.trim();
  if (override) {
    const path = resolve(override);
    await verifyArchive(path, artifact);
    return path;
  }
  const cacheRoot = join(tmpdir(), "tutti-build-cache", "uv", uv.version);
  const path = join(cacheRoot, basename(artifact.url));
  await mkdir(cacheRoot, { recursive: true });
  try {
    await verifyArchive(path, artifact);
    return path;
  } catch {
    await rm(path, { force: true });
  }
  const response = await fetch(artifact.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download ${artifact.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await verifyArchive(temporary, artifact);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

async function copyVerifiedArchive(source, target, artifact) {
  const bytes = await readFile(source);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await verifyArchive(temporary, artifact);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function verifyArchive(path, artifact) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== artifact.sizeBytes) {
    throw new Error(`uv archive size mismatch for ${path}: got ${info.size}, want ${artifact.sizeBytes}`);
  }
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== artifact.sha256) {
    throw new Error(`uv archive checksum mismatch for ${path}: got ${actual}, want ${artifact.sha256}`);
  }
}
