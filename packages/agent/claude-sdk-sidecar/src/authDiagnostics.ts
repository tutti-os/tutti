import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { stderr } from "node:process";
import { numberValue, recordValue } from "./normalizer.ts";
import { stringValue } from "./runtimeValues.ts";

const CLAUDE_AUTH_REFRESH_LOG_PREFIX = "CLAUDE_CODE_AUTH_REFRESH_DEBUG";
const CLAUDE_AUTH_REFRESH_DEBUG_ENV = "TUTTI_CLAUDE_AUTH_REFRESH_DEBUG";
const CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS = 300;
const SENSITIVE_DIAGNOSTIC_KEYS = new Set([
  "accesstoken",
  "account",
  "args",
  "cause",
  "command",
  "configdir",
  "cwd",
  "message",
  "path",
  "refreshtoken",
  "servicename",
  "stack"
]);

let cachedClaudeCredentialSnapshot:
  | {
      readonly capturedAtMs: number;
      readonly snapshot: Record<string, unknown>;
    }
  | undefined;

export function debugClaudeAuthRefreshLog(
  stage: string,
  payload: Record<string, unknown>
): void {
  if (!claudeAuthRefreshDiagnosticsEnabled()) {
    return;
  }
  try {
    stderr.write(
      `${CLAUDE_AUTH_REFRESH_LOG_PREFIX} ${JSON.stringify(
        sanitizeClaudeAuthDiagnosticPayload({
          stage,
          timestamp: new Date().toISOString(),
          ...payload
        })
      )}\n`
    );
  } catch (error) {
    stderr.write(
      `${CLAUDE_AUTH_REFRESH_LOG_PREFIX} ${JSON.stringify({
        stage: "log_failed",
        timestamp: new Date().toISOString(),
        originalStage: stage,
        error: credentialProbeErrorPayload(error)
      })}\n`
    );
  }
}

export function claudeAuthRefreshDiagnosticsEnabled(): boolean {
  return truthyEnv(process.env[CLAUDE_AUTH_REFRESH_DEBUG_ENV]);
}

export function claudeCredentialSnapshot(): Record<string, unknown> {
  const now = Date.now();
  if (
    cachedClaudeCredentialSnapshot &&
    now - cachedClaudeCredentialSnapshot.capturedAtMs <=
      CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS
  ) {
    return {
      ...cachedClaudeCredentialSnapshot.snapshot,
      cache: {
        hit: true,
        ageMs: now - cachedClaudeCredentialSnapshot.capturedAtMs,
        ttlMs: CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS
      }
    };
  }
  const configDir = claudeConfigDir();
  const keychain = claudeKeychainCredentialSnapshot(configDir);
  const plaintext = claudePlaintextCredentialSnapshot(configDir);
  const effectiveSource =
    keychain.found && keychain.hasAccessToken
      ? "keychain"
      : plaintext.found && plaintext.hasAccessToken
        ? "plaintext"
        : "none";
  const snapshot = {
    storageBackend:
      process.platform === "darwin"
        ? "keychain-with-plaintext-fallback"
        : "plaintext",
    configDirDefault: !process.env.CLAUDE_CONFIG_DIR,
    configDirScope: process.env.CLAUDE_CONFIG_DIR ? "custom" : "default",
    effectiveSource,
    keychain,
    plaintext,
    cache: {
      hit: false,
      ageMs: 0,
      ttlMs: CLAUDE_AUTH_REFRESH_CREDENTIAL_SNAPSHOT_TTL_MS
    }
  };
  cachedClaudeCredentialSnapshot = {
    capturedAtMs: now,
    snapshot
  };
  return snapshot;
}

function claudeKeychainCredentialSnapshot(
  configDir: string
): Record<string, unknown> {
  if (process.platform !== "darwin") {
    return { checked: false, reason: "non_darwin" };
  }
  const serviceName = claudeKeychainServiceName(configDir);
  const account = claudeKeychainAccount();
  try {
    const content = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", account, "-w", "-s", serviceName],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000
      }
    ).trim();
    return {
      checked: true,
      serviceVariant: claudeKeychainServiceVariant(),
      configScoped: Boolean(process.env.CLAUDE_CONFIG_DIR),
      found: Boolean(content),
      ...credentialContentSnapshot(content)
    };
  } catch (error) {
    return {
      checked: true,
      serviceVariant: claudeKeychainServiceVariant(),
      configScoped: Boolean(process.env.CLAUDE_CONFIG_DIR),
      found: false,
      error: credentialProbeErrorPayload(error)
    };
  }
}

function claudePlaintextCredentialSnapshot(
  configDir: string
): Record<string, unknown> {
  const path = `${configDir}/.credentials.json`;
  try {
    return {
      found: true,
      ...credentialContentSnapshot(readFileSync(path, "utf8"))
    };
  } catch (error) {
    return {
      found: false,
      error: credentialProbeErrorPayload(error)
    };
  }
}

function credentialContentSnapshot(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const oauth = recordValue(parsed.claudeAiOauth) ?? {};
    const expiresAt = numberValue(oauth.expiresAt);
    const accessToken = stringValue(oauth.accessToken);
    const refreshToken = stringValue(oauth.refreshToken);
    return {
      hasAccessToken: Boolean(accessToken),
      hasRefreshToken: Boolean(refreshToken),
      // Short one-way fingerprints (never the tokens themselves) so a rotation
      // is visible across process boundaries: when a second Claude process
      // refreshes, refreshTokenFp changes; a still-running process that later
      // reads the pre-rotation fingerprint is the one that will hit
      // invalid_grant and wipe the shared store. Empty string == token absent.
      accessTokenFp: accessToken ? credentialFingerprint(accessToken) : "",
      refreshTokenFp: refreshToken ? credentialFingerprint(refreshToken) : "",
      expiresAt,
      expiresAtISO: expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
      expired: expiresAt > 0 ? expiresAt <= Date.now() : null
    };
  } catch (error) {
    return {
      parseError: credentialProbeErrorPayload(error)
    };
  }
}

// credentialFingerprint reduces a secret to a short, non-reversible marker
// (first 8 hex of its SHA-256) used only to detect whether two reads saw the
// same token. It never leaves the raw token in a log line.
function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

function credentialProbeErrorPayload(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { name: "NonError" };
  }
  const withCode = error as Error & {
    code?: unknown;
    status?: unknown;
  };
  return {
    name: error.name,
    ...(withCode.code !== undefined ? { code: withCode.code } : {}),
    ...(withCode.status !== undefined ? { status: withCode.status } : {})
  };
}

export function sanitizeClaudeAuthDiagnosticPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeClaudeAuthDiagnosticPayload);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (SENSITIVE_DIAGNOSTIC_KEYS.has(key.toLowerCase())) {
      continue;
    }
    sanitized[key] = sanitizeClaudeAuthDiagnosticPayload(nestedValue);
  }
  return sanitized;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
}

function claudeKeychainAccount(): string {
  try {
    return process.env.USER || userInfo().username;
  } catch {
    return "claude-code-user";
  }
}

function claudeKeychainServiceName(configDir: string): string {
  const dirHash = process.env.CLAUDE_CONFIG_DIR
    ? `-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`
    : "";
  return `Claude Code${claudeOAuthFileSuffix()}-credentials${dirHash}`;
}

function claudeKeychainServiceVariant(): string {
  const suffix = claudeOAuthFileSuffix();
  return suffix ? suffix.slice(1) : "default";
}

function claudeOAuthFileSuffix(): string {
  if (process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    return "-custom-oauth";
  }
  if (process.env.USER_TYPE === "ant") {
    if (truthyEnv(process.env.USE_LOCAL_OAUTH)) {
      return "-local-oauth";
    }
    if (truthyEnv(process.env.USE_STAGING_OAUTH)) {
      return "-staging-oauth";
    }
  }
  return "";
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}
