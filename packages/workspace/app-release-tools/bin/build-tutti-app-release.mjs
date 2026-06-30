#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestSchemaVersion = "tutti.app.manifest.v1";
const cliManifestSchemaVersion = "tutti.app.cli.v1";
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
  createZip(packageDir, artifactPath);
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
  validateLocalizationInfo(manifest.localizationInfo, sourceLabel);
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

export function validateCLIManifest(manifest, sourceLabel = "cli manifest") {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`${sourceLabel} must be an object`);
  }
  if (manifest.schemaVersion !== cliManifestSchemaVersion) {
    throw new Error(
      `${sourceLabel} schemaVersion must be ${cliManifestSchemaVersion}`
    );
  }
  requireCLISegment(manifest.scope, `${sourceLabel}.scope`);
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    throw new Error(`${sourceLabel}.commands must be a non-empty array`);
  }
  const seenPaths = new Set();
  for (const [index, command] of manifest.commands.entries()) {
    const label = `${sourceLabel}.commands[${index}]`;
    validateCLICommand(command, label, manifest.scope, seenPaths);
  }
}

function validateCLICommand(command, label, scope, seenPaths) {
  if (!command || typeof command !== "object") {
    throw new Error(`${label} must be an object`);
  }
  if (!Array.isArray(command.path) || command.path.length === 0) {
    throw new Error(`${label}.path must be a non-empty array`);
  }
  if (command.path[0] === scope) {
    throw new Error(`${label}.path must not repeat scope`);
  }
  for (const [index, segment] of command.path.entries()) {
    requireCLISegment(segment, `${label}.path[${index}]`);
  }
  const pathKey = command.path.join(".");
  if (seenPaths.has(pathKey)) {
    throw new Error(`${label}.path must be unique`);
  }
  seenPaths.add(pathKey);
  requireNonEmpty(command.summary, `${label}.summary`);
  validateCLIVisibility(command.visibility, `${label}.visibility`);
  validateCLIInputSchema(command.inputSchema, `${label}.inputSchema`);
  validateCLIOutput(command.output, `${label}.output`);
  validateCLIHandler(command.handler, `${label}.handler`);
}

function validateCLIVisibility(visibility, label) {
  if (visibility === undefined) {
    return;
  }
  if (!["public", "integration"].includes(visibility)) {
    throw new Error(`${label} must be public or integration`);
  }
}

function validateCLIInputSchema(schema, label) {
  if (schema === undefined) {
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${label} must be an object`);
  }
  if (schema.type !== "object") {
    throw new Error(`${label}.type must be object`);
  }
  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    throw new Error(`${label}.properties must be an object`);
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    requireCLISegment(name, `${label}.properties key`);
    if (!property || typeof property !== "object" || Array.isArray(property)) {
      throw new Error(`${label}.properties.${name} must be an object`);
    }
    if (!["string", "boolean", "integer"].includes(property.type)) {
      throw new Error(
        `${label}.properties.${name}.type must be string, boolean, or integer`
      );
    }
    validateCLIInputEnum(
      property.enum,
      property.type,
      `${label}.properties.${name}.enum`
    );
    validateCLIInputDefault(
      property.default,
      property.type,
      property.enum,
      `${label}.properties.${name}.default`
    );
    for (const key of Object.keys(property)) {
      if (!["type", "description", "enum", "default"].includes(key)) {
        throw new Error(`${label}.properties.${name}.${key} is not supported`);
      }
    }
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required)) {
    throw new Error(`${label}.required must be an array`);
  }
  for (const name of required) {
    if (typeof name !== "string" || !Object.hasOwn(schema.properties, name)) {
      throw new Error(
        `${label}.required contains unknown property ${String(name)}`
      );
    }
  }
  for (const key of Object.keys(schema)) {
    if (!["type", "properties", "required"].includes(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
}

function validateCLIInputDefault(value, type, enumValues, label) {
  if (value === undefined) {
    return;
  }
  validateCLIInputValue(value, type, label);
  if (enumValues !== undefined && !enumValues.includes(value)) {
    throw new Error(`${label} must be one of the declared enum values`);
  }
}

function validateCLIInputEnum(values, type, label) {
  if (values === undefined) {
    return;
  }
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const [index, value] of values.entries()) {
    validateCLIInputValue(value, type, `${label}[${index}]`);
  }
}

function validateCLIInputValue(value, type, label) {
  if (type === "integer") {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be an integer`);
    }
    return;
  }
  if (typeof value !== type) {
    throw new Error(`${label} must be ${type}`);
  }
}

function validateCLIOutput(output, label) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error(`${label} must be an object`);
  }
  if (!["json", "table"].includes(output.defaultMode)) {
    throw new Error(`${label}.defaultMode must be json or table`);
  }
  if (output.defaultMode === "json" && output.json !== true) {
    throw new Error(`${label}.json must be true when defaultMode is json`);
  }
  if (output.defaultMode === "table") {
    if (
      !output.table ||
      !Array.isArray(output.table.columns) ||
      output.table.columns.length === 0
    ) {
      throw new Error(
        `${label}.table.columns must be a non-empty array when defaultMode is table`
      );
    }
    for (const [index, column] of output.table.columns.entries()) {
      requireCLISegment(column?.key, `${label}.table.columns[${index}].key`);
      requireNonEmpty(column?.label, `${label}.table.columns[${index}].label`);
    }
  }
}

function validateCLIHandler(handler, label) {
  if (!handler || typeof handler !== "object" || Array.isArray(handler)) {
    throw new Error(`${label} must be an object`);
  }
  if (handler.kind !== "http") {
    throw new Error(`${label}.kind must be http`);
  }
  if (handler.method !== "POST") {
    throw new Error(`${label}.method must be POST`);
  }
  if (
    typeof handler.path !== "string" ||
    !handler.path.startsWith("/tutti/cli/")
  ) {
    throw new Error(`${label}.path must start with /tutti/cli/`);
  }
  const timeoutMs = handler.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error(`${label}.timeoutMs must be between 1000 and 600000`);
  }
}

function requireCLISegment(value, label) {
  const text = requireNonEmpty(value, label);
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(text) ||
    text.startsWith("--")
  ) {
    throw new Error(
      `${label} must contain lowercase letters, numbers, and hyphen only`
    );
  }
  return text;
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

function createZip(packageDir, artifactPath) {
  const result = spawnSync("zip", ["-qr", artifactPath, "."], {
    cwd: packageDir,
    encoding: "utf8"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `zip exited with status ${result.status}`);
  }
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
