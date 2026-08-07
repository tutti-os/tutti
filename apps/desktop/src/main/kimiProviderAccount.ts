import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const KIMI_MANAGED_PROVIDER = "managed:kimi-code";
const KIMI_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_DEFAULT_OAUTH_KEY = "oauth/kimi-code";

interface KimiProviderConfig {
  baseUrl: string;
  oauthConfigured: boolean;
  oauthKey: string;
}

interface KimiConfigSnapshot {
  defaultModel: string;
  models: Map<string, string>;
  providers: Map<string, KimiProviderConfig>;
}

interface KimiOAuthCredentialsFile {
  access_token?: unknown;
  expires_at?: unknown;
}

export type KimiBillingTarget =
  | { billingMode: "api" }
  | {
      baseUrl: string;
      billingMode: "subscription";
      home: string;
      oauthKey: string;
    };

/**
 * Resolves only the active billing mode and managed-account location. API-key
 * values are never projected out of the config parser.
 */
export async function resolveKimiBillingTarget(): Promise<KimiBillingTarget> {
  if (process.env.KIMI_MODEL_NAME?.trim()) {
    return { billingMode: "api" };
  }

  const home =
    process.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code");
  const config = parseKimiConfig(
    await readOptionalFile(join(home, "config.toml"))
  );
  const providerName = config.models.get(config.defaultModel) ?? "";
  const provider = config.providers.get(providerName);

  if (
    providerName === KIMI_MANAGED_PROVIDER ||
    provider?.oauthConfigured === true
  ) {
    return managedBillingTarget(home, provider);
  }
  if (providerName) {
    return { billingMode: "api" };
  }
  if (config.defaultModel) {
    return config.defaultModel.startsWith("kimi-code/")
      ? managedBillingTarget(home, config.providers.get(KIMI_MANAGED_PROVIDER))
      : { billingMode: "api" };
  }

  const managed = config.providers.get(KIMI_MANAGED_PROVIDER);
  if (managed?.oauthConfigured) {
    return managedBillingTarget(home, managed);
  }
  if (await hasKimiOAuthCredentials(home, KIMI_DEFAULT_OAUTH_KEY)) {
    return managedBillingTarget(home, managed);
  }
  throw new Error("Kimi account configuration was not found.");
}

/**
 * Reads the provider-owned token only in Electron main. The caller must keep
 * it request-local and must never log, persist, or send it over IPC.
 */
export async function loadKimiOAuthAccessToken(
  target: Extract<KimiBillingTarget, { billingMode: "subscription" }>
): Promise<string> {
  const storageName = kimiOAuthStorageName(target.oauthKey);
  const content = await readFile(
    join(target.home, "credentials", `${storageName}.json`),
    "utf8"
  );
  const credentials = JSON.parse(content) as KimiOAuthCredentialsFile;
  const accessToken = stringValue(credentials.access_token);
  if (!accessToken) {
    throw new Error("Kimi OAuth credentials do not contain an access token.");
  }
  const expiresAt = numberValue(credentials.expires_at);
  if (expiresAt !== null && expiresAt > 0 && expiresAt * 1_000 <= Date.now()) {
    throw new Error("Kimi OAuth access token is expired.");
  }
  return accessToken;
}

function managedBillingTarget(
  home: string,
  provider: KimiProviderConfig | undefined
): Extract<KimiBillingTarget, { billingMode: "subscription" }> {
  return {
    baseUrl: (
      process.env.KIMI_CODE_BASE_URL?.trim() ||
      provider?.baseUrl ||
      KIMI_DEFAULT_BASE_URL
    ).replace(/\/+$/, ""),
    billingMode: "subscription",
    home,
    oauthKey: provider?.oauthKey || KIMI_DEFAULT_OAUTH_KEY
  };
}

async function hasKimiOAuthCredentials(
  home: string,
  oauthKey: string
): Promise<boolean> {
  try {
    const storageName = kimiOAuthStorageName(oauthKey);
    return Boolean(
      (
        await readFile(join(home, "credentials", `${storageName}.json`), "utf8")
      ).trim()
    );
  } catch {
    return false;
  }
}

function kimiOAuthStorageName(oauthKey: string): string {
  const normalized = oauthKey.trim();
  const storageName =
    normalized === "kimi-code" || normalized === KIMI_DEFAULT_OAUTH_KEY
      ? "kimi-code"
      : normalized.startsWith("oauth/")
        ? normalized.slice("oauth/".length)
        : normalized;
  if (!storageName || !/^[A-Za-z0-9._-]+$/.test(storageName)) {
    throw new Error("Kimi OAuth credential reference is invalid.");
  }
  return storageName;
}

function parseKimiConfig(content: string): KimiConfigSnapshot {
  const snapshot: KimiConfigSnapshot = {
    defaultModel: "",
    models: new Map(),
    providers: new Map()
  };
  let section: readonly string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = parseTomlPath(line.slice(1, -1));
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1] ?? "";
    const rawValue = assignment[2] ?? "";
    const value = parseTomlString(rawValue);

    if (section.length === 0 && key === "default_model") {
      snapshot.defaultModel = value;
      continue;
    }
    if (section[0] === "models" && section.length === 2 && key === "provider") {
      snapshot.models.set(section[1] ?? "", value);
      continue;
    }
    if (section[0] !== "providers" || !section[1]) continue;
    const provider = providerConfig(snapshot, section[1]);
    if (section.length === 2) {
      if (key === "base_url") provider.baseUrl = value;
      if (key === "oauth" && rawValue.trim().startsWith("{")) {
        provider.oauthConfigured = true;
        provider.oauthKey = inlineOAuthKey(rawValue) || provider.oauthKey;
      }
      continue;
    }
    if (section.length === 3 && section[2] === "oauth") {
      provider.oauthConfigured = true;
      if (key === "key" && value) provider.oauthKey = value;
    }
  }
  return snapshot;
}

function providerConfig(
  snapshot: KimiConfigSnapshot,
  name: string
): KimiProviderConfig {
  const existing = snapshot.providers.get(name);
  if (existing) return existing;
  const provider: KimiProviderConfig = {
    baseUrl: "",
    oauthConfigured: false,
    oauthKey: KIMI_DEFAULT_OAUTH_KEY
  };
  snapshot.providers.set(name, provider);
  return provider;
}

function inlineOAuthKey(value: string): string {
  const match = /(?:^|[,\s])key\s*=\s*("(?:\\.|[^"])*"|'[^']*')/.exec(value);
  return match ? parseTomlString(match[1] ?? "") : "";
}

function parseTomlPath(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (!quote) quote = character;
      else if (quote === character) quote = "";
      current += character;
      continue;
    }
    if (character === "." && !quote) {
      parts.push(parseTomlString(current));
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(parseTomlString(current));
  return parts;
}

function stripTomlComment(value: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (!quote) quote = character;
      else if (quote === character) quote = "";
      continue;
    }
    if (character === "#" && !quote) return value.slice(0, index);
  }
  return value;
}

function parseTomlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
