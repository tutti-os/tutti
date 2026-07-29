#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { requireSemver } from "./tutti-app-versioning.mjs";
import { validateCLIManifest } from "./tutti-app-cli-manifest.mjs";

export { validateCLIManifest } from "./tutti-app-cli-manifest.mjs";

const manifestSchemaVersion = "tutti.app.manifest.v1";
const releaseSchemaVersion = "tutti.app.release.v1";

export async function buildTuttiAppRelease(options) {
  const appId = requireNonEmpty(options.appId, "appId");
  requireSafePathSegment(appId, "appId");
  const packageDir = path.resolve(
    requireNonEmpty(options.packageDir, "packageDir")
  );
  const outputDir = path.resolve(
    options.outputDir ? String(options.outputDir) : "dist/tutti-app-release"
  );
  const baseUrl = normalizeBaseUrl(requireNonEmpty(options.baseUrl, "baseUrl"));
  const publishedAt =
    options.publishedAt || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const gitSha = options.gitSha || resolveGitSha();

  const manifestPath = path.join(packageDir, "tutti.app.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, manifestPath);
  if (manifest.appId !== appId) {
    throw new Error(
      `appId mismatch: input ${appId} does not match manifest ${manifest.appId}`
    );
  }

  const version = requireNonEmpty(
    options.version || manifest.version,
    "version"
  );
  requireSafePathSegment(version, "version");
  requireSemver(version, "version");
  manifest.version = version;
  validateManifest(manifest, manifestPath);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await requireExecutableFile(
    path.join(packageDir, manifest.runtime.bootstrap)
  );
  await requireNonEmptyTextFile(path.join(packageDir, "AGENTS.md"));

  const manifestIconPath = path.join(packageDir, manifest.icon.src);
  await requireFile(manifestIconPath);
  for (const locale of manifest.localizationInfo?.additionalLocales ?? []) {
    await requireNonEmptyTextFile(path.join(packageDir, locale.file));
  }
  const localizations = await readManifestLocalizations(packageDir, manifest);
  if (manifest.cli?.manifest) {
    const cliManifestPath = path.join(packageDir, manifest.cli.manifest);
    await requireFile(cliManifestPath);
    validateCLIManifest(
      JSON.parse(await readFile(cliManifestPath, "utf8")),
      `${manifestPath}.cli.manifest`
    );
  }
  const sourceIconPath = options.iconPath
    ? path.resolve(String(options.iconPath))
    : manifestIconPath;
  await requireFile(sourceIconPath);

  const releasePrefix = `apps/${appId}/${version}`;
  const releaseURLPrefix = joinURLPathSegments("apps", appId, version);
  const releaseDir = path.join(outputDir, releasePrefix);
  await mkdir(releaseDir, { recursive: true });

  const artifactName = `${appId}-${version}.zip`;
  const artifactPath = path.join(releaseDir, artifactName);
  await createZip(packageDir, artifactPath);
  const artifact = await fileDigestAndSize(artifactPath);

  const iconName = path.basename(sourceIconPath);
  const iconOutputPath = path.join(releaseDir, iconName);
  await cp(sourceIconPath, iconOutputPath);

  const releaseJson = {
    schemaVersion: releaseSchemaVersion,
    appId,
    version,
    name: manifest.name,
    description: manifest.description,
    manifest,
    ...(localizations.length > 0 ? { localizations } : {}),
    artifactUrl: `${baseUrl}/${releaseURLPrefix}/${encodeURLPathSegment(artifactName)}`,
    artifactSha256: artifact.sha256,
    artifactSizeBytes: artifact.size,
    iconUrl: `${baseUrl}/${releaseURLPrefix}/${encodeURLPathSegment(iconName)}`,
    publishedAt,
    gitSha
  };

  await writeJson(path.join(releaseDir, "release.json"), releaseJson);
  await mkdir(path.join(outputDir, "apps", appId), { recursive: true });
  await writeJson(
    path.join(outputDir, "apps", appId, "latest.json"),
    releaseJson
  );

  return {
    artifactPath,
    latestJsonPath: path.join(outputDir, "apps", appId, "latest.json"),
    releaseJsonPath: path.join(releaseDir, "release.json"),
    release: releaseJson
  };
}

export function validateManifest(manifest, sourceLabel = "manifest") {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`${sourceLabel} must be an object`);
  }
  for (const key of ["schemaVersion", "appId", "version", "name"]) {
    requireManifestString(manifest, key, sourceLabel);
  }
  if (manifest.schemaVersion !== manifestSchemaVersion) {
    throw new Error(
      `${sourceLabel} schemaVersion must be ${manifestSchemaVersion}`
    );
  }
  if (!manifest.icon || typeof manifest.icon !== "object") {
    throw new Error(`${sourceLabel} icon is required`);
  }
  requireManifestString(manifest.icon, "type", `${sourceLabel}.icon`);
  requireManifestString(manifest.icon, "src", `${sourceLabel}.icon`);
  if (!isRelativePackagePath(manifest.icon.src)) {
    throw new Error(`${sourceLabel} icon.src must be a relative package path`);
  }
  if (!manifest.runtime || typeof manifest.runtime !== "object") {
    throw new Error(`${sourceLabel} runtime is required`);
  }
  requireManifestString(
    manifest.runtime,
    "bootstrap",
    `${sourceLabel}.runtime`
  );
  requireManifestString(
    manifest.runtime,
    "healthcheckPath",
    `${sourceLabel}.runtime`
  );
  if (!isRelativePackagePath(manifest.runtime.bootstrap)) {
    throw new Error(
      `${sourceLabel} runtime.bootstrap must be a relative package path`
    );
  }
  if (!manifest.runtime.healthcheckPath.startsWith("/")) {
    throw new Error(`${sourceLabel} runtime.healthcheckPath must start with /`);
  }
  validateManifestCLI(manifest.cli, sourceLabel);
  validateManifestReferences(manifest.references, sourceLabel);
  requiredTuttiCapabilitiesForManifest(manifest, sourceLabel);
  validateLocalizationInfo(manifest.localizationInfo, sourceLabel);
}

export function requiredTuttiCapabilitiesForManifest(
  manifest,
  sourceLabel = "manifest"
) {
  const compatibility = manifest.hostCompatibility;
  if (compatibility === undefined) return [];
  if (
    !compatibility ||
    typeof compatibility !== "object" ||
    Array.isArray(compatibility)
  ) {
    throw new Error(`${sourceLabel}.hostCompatibility must be an object`);
  }
  const unsupportedKey = Object.keys(compatibility).find(
    (key) => key !== "requiredTuttiCapabilities"
  );
  if (unsupportedKey) {
    throw new Error(
      `${sourceLabel}.hostCompatibility.${unsupportedKey} is unsupported`
    );
  }
  return normalizeRequiredTuttiCapabilities(
    compatibility.requiredTuttiCapabilities,
    `${sourceLabel}.hostCompatibility.requiredTuttiCapabilities`
  );
}

export function normalizeRequiredTuttiCapabilities(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  if (value.length > 32) {
    throw new Error(`${label} must contain at most 32 capabilities`);
  }
  const capabilities = value.map((capability, index) => {
    if (typeof capability !== "string" || capability.trim() !== capability) {
      throw new Error(`${label}[${index}] must be a normalized string`);
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(capability)) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    return capability;
  });
  const normalized = [...new Set(capabilities)].sort();
  if (
    normalized.length !== capabilities.length ||
    normalized.some((capability, index) => capability !== capabilities[index])
  ) {
    throw new Error(`${label} must be sorted and unique`);
  }
  return normalized;
}

function validateManifestCLI(cli, sourceLabel) {
  if (cli === undefined) {
    return;
  }
  if (!cli || typeof cli !== "object") {
    throw new Error(`${sourceLabel} cli must be an object`);
  }
  const cliManifest = requireNonEmpty(
    cli.manifest,
    `${sourceLabel}.cli.manifest`
  );
  if (!isRelativePackagePath(cliManifest)) {
    throw new Error(
      `${sourceLabel}.cli.manifest must be a relative package path`
    );
  }
}

function validateManifestReferences(references, sourceLabel) {
  if (references === undefined) {
    return;
  }
  if (
    !references ||
    typeof references !== "object" ||
    Array.isArray(references)
  ) {
    throw new Error(`${sourceLabel} references must be an object`);
  }
  const unsupportedKey = Object.keys(references).find(
    (key) => key !== "listEndpoint" && key !== "searchEndpoint"
  );
  if (unsupportedKey) {
    throw new Error(
      `${sourceLabel}.references.${unsupportedKey} is unsupported`
    );
  }
  const listEndpoint = requireNonEmpty(
    references.listEndpoint,
    `${sourceLabel}.references.listEndpoint`
  );
  if (!isRelativeURLPath(listEndpoint)) {
    throw new Error(
      `${sourceLabel}.references.listEndpoint must be a relative URL path without query or fragment`
    );
  }
  if (references.searchEndpoint !== undefined) {
    const searchEndpoint = requireNonEmpty(
      references.searchEndpoint,
      `${sourceLabel}.references.searchEndpoint`
    );
    if (!isRelativeURLPath(searchEndpoint)) {
      throw new Error(
        `${sourceLabel}.references.searchEndpoint must be a relative URL path without query or fragment`
      );
    }
  }
}

function validateLocalizationInfo(localizationInfo, sourceLabel) {
  if (localizationInfo === undefined) {
    return;
  }
  if (!localizationInfo || typeof localizationInfo !== "object") {
    throw new Error(`${sourceLabel} localizationInfo must be an object`);
  }

  const defaultLocale = requireNonEmpty(
    localizationInfo.defaultLocale,
    `${sourceLabel}.localizationInfo.defaultLocale`
  );
  const seenLocales = new Set([defaultLocale.toLowerCase()]);
  const additionalLocales = localizationInfo.additionalLocales ?? [];
  if (!Array.isArray(additionalLocales)) {
    throw new Error(
      `${sourceLabel}.localizationInfo.additionalLocales must be an array`
    );
  }
  for (const [index, entry] of additionalLocales.entries()) {
    const label = `${sourceLabel}.localizationInfo.additionalLocales[${index}]`;
    if (!entry || typeof entry !== "object") {
      throw new Error(`${label} must be an object`);
    }
    const locale = requireNonEmpty(entry.locale, `${label}.locale`);
    const localeKey = locale.toLowerCase();
    if (seenLocales.has(localeKey)) {
      throw new Error(`${label}.locale must be unique`);
    }
    seenLocales.add(localeKey);
    const file = requireNonEmpty(entry.file, `${label}.file`);
    if (!isRelativePackagePath(file)) {
      throw new Error(`${label}.file must be a relative package path`);
    }
  }
}

export function releaseToCatalogApp(release) {
  validateRelease(release);
  return {
    ...(Array.isArray(release.localizations) && release.localizations.length > 0
      ? { localizations: release.localizations }
      : {}),
    manifest: release.manifest,
    distribution: {
      kind: "remote",
      artifactUrl: release.artifactUrl,
      artifactSha256: release.artifactSha256,
      iconUrl: release.iconUrl
    }
  };
}

export function validateRelease(release) {
  if (!release || typeof release !== "object") {
    throw new Error("release must be an object");
  }
  if (release.schemaVersion !== releaseSchemaVersion) {
    throw new Error(`release schemaVersion must be ${releaseSchemaVersion}`);
  }
  for (const key of [
    "appId",
    "version",
    "artifactUrl",
    "artifactSha256",
    "iconUrl"
  ]) {
    requireManifestString(release, key, "release");
  }
  requireSemver(release.version, "release version");
  validateManifest(release.manifest, "release.manifest");
  if (release.manifest.appId !== release.appId) {
    throw new Error("release manifest.appId must match release appId");
  }
  if (release.manifest.version !== release.version) {
    throw new Error("release manifest.version must match release version");
  }
  validateReleaseLocalizations(release.localizations, "release.localizations");
  if (!/^[a-f0-9]{64}$/i.test(release.artifactSha256)) {
    throw new Error("release artifactSha256 must be a sha256 hex digest");
  }
  if (
    !Number.isSafeInteger(release.artifactSizeBytes) ||
    release.artifactSizeBytes <= 0
  ) {
    throw new Error("release artifactSizeBytes must be a positive integer");
  }
}

async function readManifestLocalizations(packageDir, manifest) {
  const localizations = [];
  for (const entry of manifest.localizationInfo?.additionalLocales ?? []) {
    const locale = requireNonEmpty(
      entry.locale,
      "manifest localization locale"
    );
    const filePath = path.join(packageDir, entry.file);
    const document = await readLocalizationDocument(filePath);
    const localization = normalizeLocalization(document, locale, filePath);
    if (localization) {
      localizations.push(localization);
    }
  }
  return localizations;
}

function normalizeLocalization(document, locale, sourceLabel) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${sourceLabel} must be a localization object`);
  }
  const localization = {
    locale
  };
  if (document.name !== undefined) {
    const name = requireOptionalString(document.name, `${sourceLabel}.name`);
    if (name) {
      localization.name = name;
    }
  }
  if (document.description !== undefined) {
    const description = requireOptionalString(
      document.description,
      `${sourceLabel}.description`
    );
    if (description) {
      localization.description = description;
    }
  }
  if (document.tags !== undefined) {
    if (!Array.isArray(document.tags)) {
      throw new Error(`${sourceLabel}.tags must be an array`);
    }
    const tags = document.tags
      .map((tag, index) =>
        requireOptionalString(tag, `${sourceLabel}.tags[${index}]`)
      )
      .filter(Boolean);
    if (tags.length > 0) {
      localization.tags = [...new Set(tags)];
    }
  }
  if (!localization.name && !localization.description && !localization.tags) {
    return null;
  }
  return localization;
}

async function readLocalizationDocument(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `parse manifest localization file ${filePath}: ${error.message}`
    );
  }
}

function validateReleaseLocalizations(localizations, sourceLabel) {
  if (localizations === undefined) {
    return;
  }
  if (!Array.isArray(localizations)) {
    throw new Error(`${sourceLabel} must be an array`);
  }
  const seenLocales = new Set();
  for (const [index, localization] of localizations.entries()) {
    const label = `${sourceLabel}[${index}]`;
    if (!localization || typeof localization !== "object") {
      throw new Error(`${label} must be an object`);
    }
    const locale = requireNonEmpty(localization.locale, `${label}.locale`);
    const localeKey = locale.toLowerCase();
    if (seenLocales.has(localeKey)) {
      throw new Error(`${label}.locale must be unique`);
    }
    seenLocales.add(localeKey);
    if (localization.name !== undefined) {
      requireOptionalString(localization.name, `${label}.name`);
    }
    if (localization.description !== undefined) {
      requireOptionalString(localization.description, `${label}.description`);
    }
    if (localization.tags !== undefined) {
      if (!Array.isArray(localization.tags)) {
        throw new Error(`${label}.tags must be an array`);
      }
      for (const [tagIndex, tag] of localization.tags.entries()) {
        requireOptionalString(tag, `${label}.tags[${tagIndex}]`);
      }
    }
  }
}

async function createZip(packageDir, artifactPath) {
  const stagingDir = await mkdtemp(
    path.join(tmpdir(), "tutti-app-release-archive-")
  );
  const archiveRoot = path.join(stagingDir, "package");
  try {
    await cp(packageDir, archiveRoot, {
      recursive: true,
      dereference: true
    });
    const entries = await normalizeArchiveEntries(archiveRoot);
    await rm(artifactPath, { force: true });
    const result = spawnSync("zip", ["-X", "-q", artifactPath, "-@"], {
      cwd: archiveRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        LC_ALL: "C",
        TZ: "UTC"
      },
      input: `${entries.join("\n")}\n`
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        result.stderr || `zip exited with status ${result.status}`
      );
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

async function normalizeArchiveEntries(rootDir, relativeDir = "") {
  const fixedTimestamp = new Date("1980-01-01T00:00:00.000Z");
  const directoryEntries = await readdir(path.join(rootDir, relativeDir), {
    withFileTypes: true
  });
  directoryEntries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );

  const result = [];
  for (const entry of directoryEntries) {
    if (entry.name.includes("\n") || entry.name.includes("\r")) {
      throw new Error(
        `package path contains an unsupported newline: ${path.join(relativeDir, entry.name)}`
      );
    }
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(rootDir, relativePath);
    await utimes(absolutePath, fixedTimestamp, fixedTimestamp);
    if (entry.isDirectory()) {
      result.push(`${relativePath}/`);
      result.push(...(await normalizeArchiveEntries(rootDir, relativePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`unsupported package entry type: ${relativePath}`);
    }
    result.push(relativePath);
  }
  return result;
}

async function fileDigestAndSize(filePath) {
  const data = await readFile(filePath);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length
  };
}

async function requireFile(filePath) {
  const fileStat = await stat(filePath).catch((error) => {
    throw new Error(`required file missing: ${filePath}: ${error.message}`);
  });
  if (!fileStat.isFile()) {
    throw new Error(`required path is not a file: ${filePath}`);
  }
  if (fileStat.size === 0) {
    throw new Error(`required file is empty: ${filePath}`);
  }
}

async function requireNonEmptyTextFile(filePath) {
  const data = await readFile(filePath, "utf8").catch((error) => {
    throw new Error(`required file missing: ${filePath}: ${error.message}`);
  });
  if (data.trim() === "") {
    throw new Error(`required file is empty: ${filePath}`);
  }
}

async function requireExecutableFile(filePath) {
  const fileStat = await stat(filePath).catch((error) => {
    throw new Error(`required file missing: ${filePath}: ${error.message}`);
  });
  if (!fileStat.isFile()) {
    throw new Error(`required path is not a file: ${filePath}`);
  }
  if (fileStat.mode & 0o111) {
    return;
  }
  throw new Error(`required file is not executable: ${filePath}`);
}

function requireManifestString(target, key, label) {
  requireNonEmpty(target[key], `${label}.${key}`);
}

function requireNonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (text === "") {
    throw new Error(`${label} is required`);
  }
  return text;
}

function requireOptionalString(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value.trim();
}

function requireSafePathSegment(value, label) {
  if (!/^[A-Za-z0-9._+-]+$/.test(value)) {
    throw new Error(
      `${label} must use only letters, digits, dot, underscore, plus, or dash`
    );
  }
}

function isRelativePackagePath(value) {
  const text = String(value ?? "").trim();
  if (text === "" || path.isAbsolute(text) || text.startsWith("\\")) {
    return false;
  }
  return !text.split(/[\\/]+/).includes("..");
}

function isRelativeURLPath(value) {
  const text = String(value ?? "").trim();
  if (
    text === "" ||
    !text.startsWith("/") ||
    text.startsWith("//") ||
    text.includes("\0")
  ) {
    return false;
  }
  try {
    const parsed = new URL(text, "http://tutti.local");
    return (
      parsed.origin === "http://tutti.local" &&
      parsed.pathname === text &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function joinURLPathSegments(...segments) {
  return segments.map((segment) => encodeURLPathSegment(segment)).join("/");
}

function encodeURLPathSegment(value) {
  return encodeURIComponent(String(value));
}

function resolveGitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

export async function main() {
  const result = await buildTuttiAppRelease(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result.release, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
