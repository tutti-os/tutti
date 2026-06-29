import {
  workspaceAppManifestSchemaVersion,
  type WorkspaceAppManifest
} from "../contracts/manifest.ts";
import { isWorkspaceAppId, normalizeWorkspaceAppId } from "./appIdentity.ts";

const appWindowMinWidth = 280;
const appWindowMinHeight = 160;
const appWindowMaxWidth = 1600;
const appWindowMaxHeight = 1200;

export type WorkspaceAppManifestValidationIssueCode =
  | "manifest.notObject"
  | "manifest.schemaVersion"
  | "manifest.appId"
  | "manifest.name"
  | "manifest.version"
  | "manifest.description"
  | "manifest.icon"
  | "manifest.runtime"
  | "manifest.references"
  | "manifest.window"
  | "manifest.author"
  | "manifest.authors"
  | "manifest.source"
  | "manifest.tags"
  | "manifest.localizationInfo";

export interface WorkspaceAppManifestValidationIssue {
  readonly code: WorkspaceAppManifestValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface WorkspaceAppManifestValidationResult {
  readonly manifest?: WorkspaceAppManifest;
  readonly issues: readonly WorkspaceAppManifestValidationIssue[];
  readonly valid: boolean;
}

export function validateWorkspaceAppManifest(
  value: unknown
): WorkspaceAppManifestValidationResult {
  const issues: WorkspaceAppManifestValidationIssue[] = [];

  if (!isRecord(value)) {
    return {
      issues: [
        {
          code: "manifest.notObject",
          message: "Manifest must be an object.",
          path: "$"
        }
      ],
      valid: false
    };
  }

  if (value.schemaVersion !== workspaceAppManifestSchemaVersion) {
    issues.push({
      code: "manifest.schemaVersion",
      message: `schemaVersion must be ${workspaceAppManifestSchemaVersion}.`,
      path: "$.schemaVersion"
    });
  }

  const appId = readOptionalString(value.appId);
  if (!appId || !isWorkspaceAppId(normalizeWorkspaceAppId(appId))) {
    issues.push({
      code: "manifest.appId",
      message:
        "appId must contain lowercase letters, numbers, dots, hyphens, or underscores.",
      path: "$.appId"
    });
  }

  const name = readOptionalString(value.name);
  if (!name) {
    issues.push({
      code: "manifest.name",
      message: "name is required.",
      path: "$.name"
    });
  }

  const version = readOptionalString(value.version);
  if (!version) {
    issues.push({
      code: "manifest.version",
      message: "version is required.",
      path: "$.version"
    });
  }

  const description = readOptionalString(value.description);
  if (!description) {
    issues.push({
      code: "manifest.description",
      message: "description is required.",
      path: "$.description"
    });
  }

  const icon = validateIcon(value.icon, issues);
  const runtime = validateRuntime(value.runtime, issues);
  const references = validateReferences(value.references, issues);
  const window = validateWindow(value.window, issues);
  const author = validateAuthor(value.author, issues);
  const authors = validateAuthors(value.authors, issues);
  const source = validateSource(value.source, issues);
  const tags = validateTags(value.tags, issues);
  const localizationInfo = validateLocalizationInfo(
    value.localizationInfo,
    issues
  );

  if (
    issues.length > 0 ||
    !appId ||
    !name ||
    !version ||
    !description ||
    !runtime
  ) {
    return {
      issues,
      valid: false
    };
  }

  return {
    issues,
    manifest: {
      schemaVersion: workspaceAppManifestSchemaVersion,
      appId: normalizeWorkspaceAppId(appId),
      name,
      version,
      description,
      ...(icon ? { icon } : {}),
      runtime,
      ...(references ? { references } : {}),
      ...(window ? { window } : {}),
      ...(author ? { author } : {}),
      ...(authors ? { authors } : {}),
      ...(source ? { source } : {}),
      ...(tags ? { tags } : {}),
      ...(localizationInfo ? { localizationInfo } : {})
    },
    valid: true
  };
}

function validateIcon(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["icon"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push({
      code: "manifest.icon",
      message: "icon must be an object when provided.",
      path: "$.icon"
    });
    return undefined;
  }

  const type = value.type;
  const src = readOptionalString(value.src);
  if (type !== "asset" || !src || !isRelativePackagePath(src)) {
    issues.push({
      code: "manifest.icon",
      message: "icon must include type=asset and a relative src.",
      path: "$.icon"
    });
    return undefined;
  }

  return {
    type,
    src
  };
}

function validateRuntime(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["runtime"] | undefined {
  if (!isRecord(value)) {
    issues.push({
      code: "manifest.runtime",
      message: "runtime is required.",
      path: "$.runtime"
    });
    return undefined;
  }

  const bootstrap = readOptionalString(value.bootstrap);
  const healthcheckPath = readOptionalString(value.healthcheckPath);
  const profile = readOptionalString(value.profile);
  if (!bootstrap || !isRelativePackagePath(bootstrap)) {
    issues.push({
      code: "manifest.runtime",
      message: "runtime.bootstrap must be a relative package path.",
      path: "$.runtime.bootstrap"
    });
  }
  if (!healthcheckPath || !healthcheckPath.startsWith("/")) {
    issues.push({
      code: "manifest.runtime",
      message: "runtime.healthcheckPath must start with /.",
      path: "$.runtime.healthcheckPath"
    });
  }
  if (profile && profile !== "node-static") {
    issues.push({
      code: "manifest.runtime",
      message: "runtime.profile must be node-static when set.",
      path: "$.runtime.profile"
    });
  }
  if (
    !bootstrap ||
    !healthcheckPath ||
    !isRelativePackagePath(bootstrap) ||
    !healthcheckPath.startsWith("/") ||
    (profile !== undefined && profile !== "node-static")
  ) {
    return undefined;
  }

  return {
    bootstrap,
    healthcheckPath,
    ...(profile ? { profile } : {})
  };
}

function validateReferences(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["references"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push({
      code: "manifest.references",
      message: "references must be an object when provided.",
      path: "$.references"
    });
    return undefined;
  }

  const unsupportedKey = Object.keys(value).find(
    (key) => key !== "listEndpoint" && key !== "searchEndpoint"
  );
  if (unsupportedKey) {
    issues.push({
      code: "manifest.references",
      message: `references.${unsupportedKey} is unsupported.`,
      path: `$.references.${unsupportedKey}`
    });
    return undefined;
  }

  const listEndpoint = readOptionalString(value.listEndpoint);
  if (!listEndpoint || !isRelativeUrlPath(listEndpoint)) {
    issues.push({
      code: "manifest.references",
      message:
        "references.listEndpoint must be a relative URL path without query or fragment.",
      path: "$.references.listEndpoint"
    });
    return undefined;
  }

  if (value.searchEndpoint !== undefined) {
    const searchEndpoint = readOptionalString(value.searchEndpoint);
    if (!searchEndpoint || !isRelativeUrlPath(searchEndpoint)) {
      issues.push({
        code: "manifest.references",
        message:
          "references.searchEndpoint must be a relative URL path without query or fragment.",
        path: "$.references.searchEndpoint"
      });
      return undefined;
    }
    return { listEndpoint, searchEndpoint };
  }

  return { listEndpoint };
}

function validateWindow(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["window"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push({
      code: "manifest.window",
      message: "window must be an object when provided.",
      path: "$.window"
    });
    return undefined;
  }

  const minimizeBehavior = value.minimizeBehavior;
  if (
    minimizeBehavior !== undefined &&
    minimizeBehavior !== "keep-mounted" &&
    minimizeBehavior !== "hibernate"
  ) {
    issues.push({
      code: "manifest.window",
      message:
        "window.minimizeBehavior must be keep-mounted or hibernate when provided.",
      path: "$.window.minimizeBehavior"
    });
    return undefined;
  }
  const minWidth = validateWindowSize(
    value.minWidth,
    "minWidth",
    appWindowMinWidth,
    appWindowMaxWidth,
    issues
  );
  const minHeight = validateWindowSize(
    value.minHeight,
    "minHeight",
    appWindowMinHeight,
    appWindowMaxHeight,
    issues
  );
  if (minWidth === null || minHeight === null) {
    return undefined;
  }

  return {
    ...(minimizeBehavior ? { minimizeBehavior } : {}),
    ...(minHeight === undefined ? {} : { minHeight }),
    ...(minWidth === undefined ? {} : { minWidth })
  };
}

function validateWindowSize(
  value: unknown,
  field: "minHeight" | "minWidth",
  minimum: number,
  maximum: number,
  issues: WorkspaceAppManifestValidationIssue[]
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    issues.push({
      code: "manifest.window",
      message: `window.${field} must be an integer between ${minimum} and ${maximum} when provided.`,
      path: `$.window.${field}`
    });
    return null;
  }
  return value;
}

function validateAuthor(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["author"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push({
      code: "manifest.author",
      message: "author must be an object when provided.",
      path: "$.author"
    });
    return undefined;
  }

  const name = readOptionalString(value.name);
  const url = readOptionalString(value.url);
  const avatarUrl = readOptionalString(value.avatarUrl);
  if (
    !name ||
    (value.url !== undefined && !url) ||
    (value.avatarUrl !== undefined && !avatarUrl)
  ) {
    issues.push({
      code: "manifest.author",
      message: "author must include name and optional non-empty url/avatarUrl.",
      path: "$.author"
    });
    return undefined;
  }

  return {
    name,
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(url ? { url } : {})
  };
}

function validateAuthors(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["authors"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      code: "manifest.authors",
      message: "authors must be a non-empty array when provided.",
      path: "$.authors"
    });
    return undefined;
  }

  const authors: NonNullable<WorkspaceAppManifest["authors"]>[number][] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      issues.push({
        code: "manifest.authors",
        message: "authors entries must be objects.",
        path: `$.authors[${index}]`
      });
      continue;
    }

    const name = readOptionalString(entry.name);
    const url = readOptionalString(entry.url);
    const avatarUrl = readOptionalString(entry.avatarUrl);
    if (
      !name ||
      (entry.url !== undefined && !url) ||
      (entry.avatarUrl !== undefined && !avatarUrl)
    ) {
      issues.push({
        code: "manifest.authors",
        message:
          "authors entries must include name and optional non-empty url/avatarUrl.",
        path: `$.authors[${index}]`
      });
      continue;
    }

    authors.push({
      name,
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(url ? { url } : {})
    });
  }

  return authors.length > 0 ? authors : undefined;
}

function validateSource(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["source"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push({
      code: "manifest.source",
      message: "source must be an object when provided.",
      path: "$.source"
    });
    return undefined;
  }

  const type = value.type;
  const url = readOptionalString(value.url);
  if (type !== "github" || !url) {
    issues.push({
      code: "manifest.source",
      message: "source must include type=github and a non-empty url.",
      path: "$.source"
    });
    return undefined;
  }

  return { type, url };
}

function validateTags(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    issues.push({
      code: "manifest.tags",
      message: "tags must be an array when provided.",
      path: "$.tags"
    });
    return undefined;
  }

  const tags = value
    .map((tag) => readOptionalString(tag))
    .filter((tag): tag is string => Boolean(tag));
  if (tags.length !== value.length) {
    issues.push({
      code: "manifest.tags",
      message: "tags must only contain non-empty strings.",
      path: "$.tags"
    });
  }

  return Array.from(new Set(tags));
}

function validateLocalizationInfo(
  value: unknown,
  issues: WorkspaceAppManifestValidationIssue[]
): WorkspaceAppManifest["localizationInfo"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    issues.push({
      code: "manifest.localizationInfo",
      message: "localizationInfo must be an object when provided.",
      path: "$.localizationInfo"
    });
    return undefined;
  }

  const defaultLocale = readOptionalString(value.defaultLocale);
  if (!defaultLocale) {
    issues.push({
      code: "manifest.localizationInfo",
      message: "localizationInfo.defaultLocale is required.",
      path: "$.localizationInfo.defaultLocale"
    });
  }

  const additionalLocalesValue = value.additionalLocales;
  if (
    additionalLocalesValue !== undefined &&
    !Array.isArray(additionalLocalesValue)
  ) {
    issues.push({
      code: "manifest.localizationInfo",
      message: "localizationInfo.additionalLocales must be an array.",
      path: "$.localizationInfo.additionalLocales"
    });
    return undefined;
  }

  const seenLocales = new Set(
    defaultLocale ? [defaultLocale.toLowerCase()] : []
  );
  const additionalLocales: {
    readonly file: string;
    readonly locale: string;
  }[] = [];
  for (const [index, entry] of (additionalLocalesValue ?? []).entries()) {
    if (!isRecord(entry)) {
      issues.push({
        code: "manifest.localizationInfo",
        message: "localizationInfo.additionalLocales entries must be objects.",
        path: `$.localizationInfo.additionalLocales[${index}]`
      });
      continue;
    }

    const locale = readOptionalString(entry.locale);
    const file = readOptionalString(entry.file);
    if (!locale || !file || !isRelativePackagePath(file)) {
      issues.push({
        code: "manifest.localizationInfo",
        message:
          "localizationInfo.additionalLocales entries must include locale and a relative file path.",
        path: `$.localizationInfo.additionalLocales[${index}]`
      });
      continue;
    }

    const localeKey = locale.toLowerCase();
    if (seenLocales.has(localeKey)) {
      issues.push({
        code: "manifest.localizationInfo",
        message: "localizationInfo locales must be unique.",
        path: `$.localizationInfo.additionalLocales[${index}].locale`
      });
      continue;
    }

    seenLocales.add(localeKey);
    additionalLocales.push({ locale, file });
  }

  if (
    !defaultLocale ||
    issues.some((issue) => issue.code === "manifest.localizationInfo")
  ) {
    return undefined;
  }

  return {
    defaultLocale,
    ...(additionalLocales.length > 0 ? { additionalLocales } : {})
  };
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRelativePackagePath(value: string): boolean {
  return !value.startsWith("/") && !value.split(/[\\/]/u).includes("..");
}

function isRelativeUrlPath(value: string): boolean {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\0")
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "http://tutti.local");
    return (
      parsed.origin === "http://tutti.local" &&
      parsed.pathname === value &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
