import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface CodeBuddySettings {
  apiKeyHelper?: unknown;
  endpoint?: unknown;
  env?: Record<string, unknown>;
}

interface CodeBuddyStoredSession {
  account?: {
    uid?: unknown;
  };
  auth?: {
    accessToken?: unknown;
    domain?: unknown;
    expiresAt?: unknown;
  };
}

export interface CodeBuddyAccountUsageCredential {
  accessToken: string;
  baseUrl: string;
  userId: string;
}

export type CodeBuddyBillingTarget =
  | { billingMode: "api" }
  | { billingMode: "subscription" }
  | {
      billingMode: "provider_account";
      /** Main-process-only credential; never project this target over IPC. */
      usageCredential?: CodeBuddyAccountUsageCredential;
    };

/**
 * Resolves CodeBuddy's active billing mode and, for provider accounts, the
 * main-process-only credential needed for the bounded account-usage request.
 * Callers must project only `billingMode` and parsed quota values over IPC.
 */
export async function resolveCodeBuddyBillingTarget(): Promise<CodeBuddyBillingTarget> {
  const configHome =
    process.env.CODEBUDDY_CONFIG_DIR?.trim() || join(homedir(), ".codebuddy");
  const settings = await readCodeBuddySettings(
    join(configHome, "settings.json")
  );
  const settingsEnv = settings.env ?? {};

  const authToken = configuredValue(
    settingsEnv.CODEBUDDY_AUTH_TOKEN,
    process.env.CODEBUDDY_AUTH_TOKEN
  );
  if (authToken) {
    return providerAccountTarget(
      accountUsageCredential(authToken, jwtSubject(authToken), "")
    );
  }
  if (stringValue(settings.apiKeyHelper)) {
    return providerAccountTarget();
  }

  const apiKey = configuredValue(
    settingsEnv.CODEBUDDY_API_KEY,
    process.env.CODEBUDDY_API_KEY
  );
  if (apiKey) {
    const baseUrl =
      configuredValue(
        settingsEnv.CODEBUDDY_BASE_URL,
        process.env.CODEBUDDY_BASE_URL
      ) || stringValue(settings.endpoint);
    return isCodingPlanCredential(apiKey, baseUrl)
      ? codingPlanTarget()
      : { billingMode: "api" };
  }

  const storedSession = await loadCodeBuddyStoredSession(homedir());
  if (!storedSession) {
    throw new Error("CodeBuddy account configuration was not found.");
  }
  const expiresAt = numberValue(storedSession.auth?.expiresAt);
  if (
    expiresAt !== null &&
    expiresAt > 0 &&
    normalizeUnixMs(expiresAt) <= Date.now()
  ) {
    throw new Error("CodeBuddy account session is expired.");
  }
  const accessToken = stringValue(storedSession.auth?.accessToken);
  const userId = stringValue(storedSession.account?.uid);
  const domain = stringValue(storedSession.auth?.domain);
  return providerAccountTarget(
    accountUsageCredential(
      accessToken,
      userId || jwtSubject(accessToken),
      domain
    )
  );
}

function codingPlanTarget(): Extract<
  CodeBuddyBillingTarget,
  { billingMode: "subscription" }
> {
  return { billingMode: "subscription" };
}

function providerAccountTarget(): Extract<
  CodeBuddyBillingTarget,
  { billingMode: "provider_account" }
>;
function providerAccountTarget(
  usageCredential: CodeBuddyAccountUsageCredential | null
): Extract<CodeBuddyBillingTarget, { billingMode: "provider_account" }>;
function providerAccountTarget(
  usageCredential?: CodeBuddyAccountUsageCredential | null
): Extract<CodeBuddyBillingTarget, { billingMode: "provider_account" }> {
  return {
    billingMode: "provider_account",
    ...(usageCredential ? { usageCredential } : {})
  };
}

function accountUsageCredential(
  accessToken: string,
  userId: string,
  domain: string
): CodeBuddyAccountUsageCredential | null {
  const normalizedToken = accessToken.replace(/^Bearer\s+/iu, "").trim();
  if (!normalizedToken || !userId) return null;
  return {
    accessToken: normalizedToken,
    baseUrl: codeBuddyAccountBaseUrl(domain),
    userId
  };
}

function codeBuddyAccountBaseUrl(domain: string): string {
  const normalized = domain.trim().toLowerCase();
  if (normalized === "www.codebuddy.ai" || normalized === "codebuddy.ai") {
    return "https://www.codebuddy.ai";
  }
  return "https://copilot.tencent.com";
}

function jwtSubject(token: string): string {
  try {
    const compactToken = token.replace(/^Bearer\s+/iu, "").trim();
    const payload = compactToken.split(".")[1];
    if (!payload) return "";
    const value = objectValue(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown
    );
    return stringValue(value?.sub);
  } catch {
    return "";
  }
}

async function readCodeBuddySettings(path: string): Promise<CodeBuddySettings> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }
  const value = JSON.parse(content) as unknown;
  if (!objectValue(value)) {
    throw new Error("CodeBuddy settings must contain a JSON object.");
  }
  return value as CodeBuddySettings;
}

async function loadCodeBuddyStoredSession(
  home: string
): Promise<CodeBuddyStoredSession | null> {
  for (const directory of codeBuddyAuthDirectories(home)) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFoundError(error)) continue;
      throw error;
    }
    for (const name of names
      .filter((value) => value.endsWith(".info"))
      .sort()) {
      try {
        const value = JSON.parse(
          await readFile(join(directory, name), "utf8")
        ) as unknown;
        const session = objectValue(value) as CodeBuddyStoredSession | null;
        if (stringValue(session?.auth?.accessToken)) return session;
      } catch (error) {
        if (error instanceof SyntaxError || isNotFoundError(error)) continue;
        throw error;
      }
    }
  }
  return null;
}

function codeBuddyAuthDirectories(home: string): string[] {
  if (process.platform === "darwin") {
    return [
      join(
        home,
        "Library",
        "Application Support",
        "CodeBuddyExtension",
        "Data",
        "Public",
        "auth"
      )
    ];
  }
  if (process.platform === "win32") {
    return [
      join(
        process.env.APPDATA?.trim() || join(home, "AppData", "Roaming"),
        "CodeBuddyExtension",
        "Data",
        "Public",
        "auth"
      )
    ];
  }
  return [
    join(
      process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config"),
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth"
    )
  ];
}

function isCodingPlanCredential(apiKey: string, baseUrl: string): boolean {
  if (apiKey.trim().toLowerCase().startsWith("sk-sp-")) return true;
  if (!baseUrl.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.pathname
      .split("/")
      .some((segment) => segment.toLowerCase() === "coding");
  } catch {
    return /(?:^|\/)coding(?:\/|$)/i.test(baseUrl);
  }
}

function configuredValue(
  settingsValue: unknown,
  environmentValue: string | undefined
): string {
  return stringValue(settingsValue) || environmentValue?.trim() || "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeUnixMs(value: number): number {
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
