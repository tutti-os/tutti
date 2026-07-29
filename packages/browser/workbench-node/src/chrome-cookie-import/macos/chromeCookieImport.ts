import { execFile } from "node:child_process";
import {
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  timingSafeEqual
} from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { readChromeProfileAvatarDataUrl } from "./chromeProfileMetadata.ts";

const CHROME_KEYCHAIN_SERVICE = "Chrome Safe Storage";
const CHROME_KEYCHAIN_TIMEOUT_MS = 60_000;
const CHROME_COOKIE_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const CHROME_V10_PREFIX = Buffer.from("v10");
const MACOS_CHROME_IV = Buffer.alloc(16, 0x20);
const MACOS_CHROME_SALT = Buffer.from("saltysalt");
const PROFILE_DIRECTORY_PATTERN = /^(?:Default|Profile \d+)$/;

export interface ChromeCookieProfile {
  avatarDataUrl?: string;
  email?: string;
  id: string;
  name: string;
}

export interface PreparedChromeCookie {
  domain?: string;
  expirationDate?: number;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: "lax" | "no_restriction" | "strict" | "unspecified";
  secure: boolean;
  url: string;
  value: string;
}

export interface PreparedChromeCookies {
  cookies: PreparedChromeCookie[];
  databaseVersion: number;
  skipped: number;
}

export type ChromeCookieImportErrorCode =
  | "unsupported_platform"
  | "chrome_unavailable"
  | "profile_not_found"
  | "profile_invalid"
  | "snapshot_failed"
  | "keychain_denied"
  | "keychain_timeout"
  | "keychain_failed"
  | "schema_unsupported"
  | "cipher_incompatible"
  | "integrity_failed"
  | "database_failed";

export class ChromeCookieImportError extends Error {
  readonly code: ChromeCookieImportErrorCode;

  constructor(code: ChromeCookieImportErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ChromeCookieImportError";
    this.code = code;
  }
}

interface ChromeCookieImportDependencies {
  chromeUserDataRoot: string;
  now: () => number;
  platform: NodeJS.Platform;
  readKeychainSecret: () => Promise<Buffer>;
  withSnapshot: <T>(
    sourcePath: string,
    readSnapshot: (snapshotPath: string) => Promise<T>
  ) => Promise<T>;
}

export type ChromeCookieImportDependencyOverrides =
  Partial<ChromeCookieImportDependencies>;

interface ResolvedChromeProfile extends ChromeCookieProfile {
  cookieDatabasePath: string;
  directoryName: string;
}

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<string, unknown>;
  };
}

interface ChromeCookieRow {
  encrypted_value: Uint8Array | null;
  expires_utc: number | bigint | string | null;
  has_expires: number | bigint | string | null;
  host_key: string;
  is_httponly: number | bigint | string | null;
  is_partitioned: number | bigint | string | null;
  is_persistent: number | bigint | string | null;
  is_secure: number | bigint | string | null;
  name: string;
  partition_key: string | null;
  path: string;
  samesite: number | bigint | string | null;
  top_frame_site_key: string | null;
  value: string;
}

interface CookieDatabaseContents {
  rows: ChromeCookieRow[];
  version: number;
}

const defaultDependencies: ChromeCookieImportDependencies = {
  chromeUserDataRoot: join(
    homedir(),
    "Library",
    "Application Support",
    "Google",
    "Chrome"
  ),
  now: Date.now,
  platform: process.platform,
  readKeychainSecret: readChromeSafeStorageSecret,
  withSnapshot: withChromeCookieDatabaseSnapshot
};

export async function discoverChromeCookieProfiles(
  overrides: ChromeCookieImportDependencyOverrides = {}
): Promise<ChromeCookieProfile[]> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (dependencies.platform !== "darwin") {
    return [];
  }
  return (await resolveChromeProfiles(dependencies)).map(
    ({ avatarDataUrl, email, id, name }) => ({
      ...(avatarDataUrl ? { avatarDataUrl } : {}),
      ...(email ? { email } : {}),
      id,
      name
    })
  );
}

export async function prepareChromeCookies(
  profileId: string,
  overrides: ChromeCookieImportDependencyOverrides = {},
  signal?: AbortSignal
): Promise<PreparedChromeCookies> {
  signal?.throwIfAborted();
  const dependencies = { ...defaultDependencies, ...overrides };
  if (dependencies.platform !== "darwin") {
    throw new ChromeCookieImportError("unsupported_platform");
  }

  const profiles = await resolveChromeProfiles(dependencies);
  signal?.throwIfAborted();
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new ChromeCookieImportError("profile_not_found");
  }
  await validateProfileAndDatabase(
    dependencies.chromeUserDataRoot,
    profile.directoryName,
    profile.cookieDatabasePath
  );

  return dependencies.withSnapshot(profile.cookieDatabasePath, async (path) => {
    signal?.throwIfAborted();
    const database = readCookieDatabase(path);
    const now = dependencies.now();
    const needsKeychain = database.rows.some(
      (row) =>
        !isPartitionedCookie(row) &&
        normalizeCookieMetadata(row, now) !== null &&
        bufferValue(row.encrypted_value).length > 0
    );
    let secret: Buffer | null = null;
    let key: Buffer | null = null;
    try {
      if (needsKeychain) {
        secret = await dependencies.readKeychainSecret();
        signal?.throwIfAborted();
        if (secret.length === 0) {
          throw new ChromeCookieImportError("keychain_failed");
        }
        key = pbkdf2Sync(secret, MACOS_CHROME_SALT, 1003, 16, "sha1");
      }
      signal?.throwIfAborted();
      return normalizeCookieRows(database, key, now);
    } finally {
      key?.fill(0);
      secret?.fill(0);
    }
  });
}

export function decryptChromeV10CookieForTesting(
  encryptedValue: Uint8Array,
  secret: Uint8Array,
  hostKey: string,
  databaseVersion: number
): string {
  const secretBuffer = Buffer.from(secret);
  const key = pbkdf2Sync(secretBuffer, MACOS_CHROME_SALT, 1003, 16, "sha1");
  try {
    return decryptChromeCookie(
      Buffer.from(encryptedValue),
      key,
      hostKey,
      databaseVersion
    );
  } finally {
    key.fill(0);
    secretBuffer.fill(0);
  }
}

async function resolveChromeProfiles(
  dependencies: ChromeCookieImportDependencies
): Promise<ResolvedChromeProfile[]> {
  const root = resolve(dependencies.chromeUserDataRoot);
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return [];
    }
    if ((await realpath(root)) !== root) {
      return [];
    }
  } catch {
    return [];
  }

  let localState: ChromeLocalState;
  try {
    localState = JSON.parse(
      await readFile(join(root, "Local State"), "utf8")
    ) as ChromeLocalState;
  } catch {
    return [];
  }

  const infoCache = localState.profile?.info_cache;
  if (!infoCache || typeof infoCache !== "object") {
    return [];
  }

  const profiles: ResolvedChromeProfile[] = [];
  for (const [directoryName, rawMetadata] of Object.entries(infoCache)) {
    if (!isSafeProfileDirectoryName(directoryName)) {
      continue;
    }
    const metadata = objectValue(rawMetadata);
    if (!metadata) {
      continue;
    }
    const cookieDatabasePath = await findCookieDatabase(root, directoryName);
    if (!cookieDatabasePath) {
      continue;
    }
    try {
      await validateProfileAndDatabase(root, directoryName, cookieDatabasePath);
    } catch {
      continue;
    }
    const name =
      stringValue(metadata.name) ??
      stringValue(metadata.gaia_name) ??
      (directoryName === "Default" ? "Default" : directoryName);
    const email = stringValue(metadata.user_name);
    const avatarDataUrl = await readChromeProfileAvatarDataUrl(
      join(root, directoryName)
    );
    profiles.push({
      ...(avatarDataUrl ? { avatarDataUrl } : {}),
      cookieDatabasePath,
      directoryName,
      ...(email ? { email } : {}),
      id: opaqueProfileId(directoryName),
      name
    });
  }
  return profiles;
}

async function findCookieDatabase(
  root: string,
  directoryName: string
): Promise<string | null> {
  const profilePath = join(root, directoryName);
  for (const candidate of [
    join(profilePath, "Network", "Cookies"),
    join(profilePath, "Cookies")
  ]) {
    try {
      const stat = await lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        return candidate;
      }
    } catch {
      // Try the older location when Network/Cookies is absent.
    }
  }
  return null;
}

async function validateProfileAndDatabase(
  rootInput: string,
  directoryName: string,
  cookieDatabasePath: string
): Promise<void> {
  if (!isSafeProfileDirectoryName(directoryName)) {
    throw new ChromeCookieImportError("profile_invalid");
  }
  const root = resolve(rootInput);
  const profilePath = join(root, directoryName);
  const expectedDatabasePaths = new Set([
    join(profilePath, "Network", "Cookies"),
    join(profilePath, "Cookies")
  ]);
  if (!expectedDatabasePaths.has(resolve(cookieDatabasePath))) {
    throw new ChromeCookieImportError("profile_invalid");
  }
  try {
    const profileStat = await lstat(profilePath);
    const databaseStat = await lstat(cookieDatabasePath);
    if (
      !profileStat.isDirectory() ||
      profileStat.isSymbolicLink() ||
      !databaseStat.isFile() ||
      databaseStat.isSymbolicLink()
    ) {
      throw new ChromeCookieImportError("profile_invalid");
    }
    const resolvedRoot = await realpath(root);
    const resolvedProfile = await realpath(profilePath);
    const resolvedDatabase = await realpath(cookieDatabasePath);
    if (
      !isImmediateChild(resolvedRoot, resolvedProfile) ||
      !isPathInside(resolvedProfile, resolvedDatabase)
    ) {
      throw new ChromeCookieImportError("profile_invalid");
    }
  } catch (error) {
    if (error instanceof ChromeCookieImportError) {
      throw error;
    }
    throw new ChromeCookieImportError("profile_invalid");
  }
}

function readCookieDatabase(path: string): CookieDatabaseContents {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cookies', 'meta')"
      )
      .all() as Array<{ name?: unknown }>;
    if (
      !tables.some((row) => row.name === "cookies") ||
      !tables.some((row) => row.name === "meta")
    ) {
      throw new ChromeCookieImportError("schema_unsupported");
    }
    const columns = new Set(
      (
        database.prepare("PRAGMA table_info(cookies)").all() as Array<{
          name?: unknown;
        }>
      )
        .map((row) => stringValue(row.name))
        .filter((name): name is string => name !== null)
    );
    const required = [
      "host_key",
      "name",
      "value",
      "encrypted_value",
      "path",
      "expires_utc",
      "is_secure",
      "is_httponly"
    ];
    if (required.some((column) => !columns.has(column))) {
      throw new ChromeCookieImportError("schema_unsupported");
    }
    const versionRow = database
      .prepare("SELECT value FROM meta WHERE key = 'version'")
      .get() as { value?: unknown } | undefined;
    const version = integerValue(versionRow?.value);
    if (version === null || version < 1) {
      throw new ChromeCookieImportError("schema_unsupported");
    }
    const optional = (name: string, fallback: string): string =>
      columns.has(name) ? `"${name}"` : `${fallback} AS "${name}"`;
    const query = `SELECT
      "host_key", "name", "value", "encrypted_value", "path",
      "expires_utc", "is_secure", "is_httponly",
      ${optional("has_expires", "NULL")},
      ${optional("is_persistent", "NULL")},
      ${optional("samesite", "-1")},
      ${optional("top_frame_site_key", "NULL")},
      ${optional("partition_key", "NULL")},
      ${optional("is_partitioned", "0")}
      FROM cookies`;
    const cookieStatement = database.prepare(query);
    cookieStatement.setReadBigInts(true);
    return {
      rows: cookieStatement.all() as unknown as ChromeCookieRow[],
      version
    };
  } catch (error) {
    if (error instanceof ChromeCookieImportError) {
      throw error;
    }
    throw new ChromeCookieImportError("database_failed");
  } finally {
    database?.close();
  }
}

function normalizeCookieRows(
  database: CookieDatabaseContents,
  key: Buffer | null,
  nowUnixMs: number
): PreparedChromeCookies {
  const cookies: PreparedChromeCookie[] = [];
  let skipped = 0;
  let encryptedAttempts = 0;
  let decrypted = 0;
  let cipherFailures = 0;
  let integrityFailures = 0;

  for (const row of database.rows) {
    if (isPartitionedCookie(row)) {
      skipped += 1;
      continue;
    }
    const normalized = normalizeCookieMetadata(row, nowUnixMs);
    if (!normalized) {
      skipped += 1;
      continue;
    }

    let value: string;
    const encryptedValue = bufferValue(row.encrypted_value);
    if (encryptedValue.length > 0) {
      encryptedAttempts += 1;
      if (!key || !encryptedValue.subarray(0, 3).equals(CHROME_V10_PREFIX)) {
        cipherFailures += 1;
        skipped += 1;
        continue;
      }
      try {
        value = decryptChromeCookie(
          encryptedValue,
          key,
          row.host_key,
          database.version
        );
        decrypted += 1;
      } catch (error) {
        if (
          error instanceof ChromeCookieImportError &&
          error.code === "integrity_failed"
        ) {
          integrityFailures += 1;
        } else {
          cipherFailures += 1;
        }
        skipped += 1;
        continue;
      }
    } else if (typeof row.value === "string") {
      value = row.value;
    } else {
      skipped += 1;
      continue;
    }
    cookies.push({ ...normalized, value });
  }

  if (encryptedAttempts > 0 && decrypted === 0) {
    cookies.length = 0;
    if (integrityFailures > 0) {
      throw new ChromeCookieImportError("integrity_failed");
    }
    if (cipherFailures > 0) {
      throw new ChromeCookieImportError("cipher_incompatible");
    }
  }
  return { cookies, databaseVersion: database.version, skipped };
}

function normalizeCookieMetadata(
  row: ChromeCookieRow,
  nowUnixMs: number
): Omit<PreparedChromeCookie, "value"> | null {
  if (
    typeof row.host_key !== "string" ||
    typeof row.name !== "string" ||
    typeof row.path !== "string" ||
    row.name.length === 0
  ) {
    return null;
  }
  const hostname = row.host_key.replace(/^\./, "");
  if (!hostname || /[\s/:]/.test(hostname)) {
    return null;
  }
  const secure = booleanInteger(row.is_secure);
  const path = row.path.startsWith("/") ? row.path : "/";
  const url = `${secure ? "https" : "http"}://${hostname}${path}`;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== hostname) {
      return null;
    }
  } catch {
    return null;
  }

  const hasExpires =
    row.has_expires === null
      ? chromeTimestampToUnixSeconds(row.expires_utc) > 0
      : booleanInteger(row.has_expires);
  const persistent =
    row.is_persistent === null ? hasExpires : booleanInteger(row.is_persistent);
  let expirationDate: number | undefined;
  if (hasExpires && persistent) {
    expirationDate = chromeTimestampToUnixSeconds(row.expires_utc);
    if (
      !Number.isFinite(expirationDate) ||
      expirationDate <= nowUnixMs / 1000
    ) {
      return null;
    }
  }

  return {
    ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
    ...(expirationDate === undefined ? {} : { expirationDate }),
    httpOnly: booleanInteger(row.is_httponly),
    name: row.name,
    path,
    sameSite: chromeSameSite(row.samesite),
    secure,
    url
  };
}

function decryptChromeCookie(
  encryptedValue: Buffer,
  key: Buffer,
  hostKey: string,
  databaseVersion: number
): string {
  if (
    encryptedValue.length <= CHROME_V10_PREFIX.length ||
    !encryptedValue.subarray(0, 3).equals(CHROME_V10_PREFIX)
  ) {
    throw new ChromeCookieImportError("cipher_incompatible");
  }
  let plaintext: Buffer | null = null;
  let decryptedBuffer: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, MACOS_CHROME_IV);
    decryptedBuffer = Buffer.concat([
      decipher.update(encryptedValue.subarray(CHROME_V10_PREFIX.length)),
      decipher.final()
    ]);
    plaintext = decryptedBuffer;
    if (databaseVersion >= 24) {
      if (plaintext.length < 32) {
        throw new ChromeCookieImportError("integrity_failed");
      }
      const expectedHash = createHash("sha256").update(hostKey).digest();
      const actualHash = plaintext.subarray(0, 32);
      const matches = timingSafeEqual(expectedHash, actualHash);
      expectedHash.fill(0);
      if (!matches) {
        throw new ChromeCookieImportError("integrity_failed");
      }
      plaintext = plaintext.subarray(32);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new ChromeCookieImportError("cipher_incompatible");
    }
  } catch (error) {
    if (error instanceof ChromeCookieImportError) {
      throw error;
    }
    throw new ChromeCookieImportError("cipher_incompatible");
  } finally {
    decryptedBuffer?.fill(0);
  }
}

export async function withChromeCookieDatabaseSnapshot<T>(
  sourcePath: string,
  readSnapshot: (snapshotPath: string) => Promise<T>
): Promise<T> {
  let temporaryDirectory: string;
  try {
    temporaryDirectory = await mkdtemp(
      join(tmpdir(), "tutti-chrome-cookie-import-")
    );
  } catch {
    throw new ChromeCookieImportError("snapshot_failed");
  }
  const snapshotPath = join(temporaryDirectory, "Cookies");
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(database, snapshotPath);
    database.close();
    database = null;
    const verification = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const result = verification.prepare("PRAGMA quick_check").get() as
        | { quick_check?: unknown }
        | undefined;
      if (result?.quick_check !== "ok") {
        throw new Error("snapshot verification failed");
      }
    } finally {
      verification.close();
    }
    return await readSnapshot(snapshotPath);
  } catch (error) {
    if (error instanceof ChromeCookieImportError) {
      throw error;
    }
    throw new ChromeCookieImportError("snapshot_failed");
  } finally {
    database?.close();
    try {
      await rm(temporaryDirectory, { force: true, recursive: true });
    } catch {
      // Cleanup is best-effort after every outcome and never masks the
      // classified import failure that caused the operation to unwind.
    }
  }
}

export function classifyChromeKeychainFailure(
  error: unknown,
  stderr: string
): ChromeCookieImportErrorCode {
  const details = objectValue(error);
  if (details?.killed === true || details?.signal === "SIGTERM") {
    return "keychain_timeout";
  }
  return /user interaction is not allowed|user canceled|user cancelled|errsecusercanceled|denied/i.test(
    stderr
  )
    ? "keychain_denied"
    : "keychain_failed";
}

export async function readChromeSafeStorageSecret(): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-w", "-s", CHROME_KEYCHAIN_SERVICE],
      {
        encoding: "buffer",
        maxBuffer: 64 * 1024,
        timeout: CHROME_KEYCHAIN_TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout)
          ? stdout
          : Buffer.from(stdout ?? "");
        const stderrText = Buffer.isBuffer(stderr)
          ? stderr.toString("utf8")
          : String(stderr ?? "");
        try {
          if (error) {
            rejectPromise(
              new ChromeCookieImportError(
                classifyChromeKeychainFailure(error, stderrText)
              )
            );
            return;
          }
          let end = stdoutBuffer.length;
          while (
            end > 0 &&
            (stdoutBuffer[end - 1] === 0x0a || stdoutBuffer[end - 1] === 0x0d)
          ) {
            end -= 1;
          }
          const secret = Buffer.from(stdoutBuffer.subarray(0, end));
          if (secret.length === 0) {
            secret.fill(0);
            rejectPromise(new ChromeCookieImportError("keychain_failed"));
            return;
          }
          resolvePromise(secret);
        } finally {
          stdoutBuffer.fill(0);
        }
      }
    );
  });
}

function opaqueProfileId(directoryName: string): string {
  return createHash("sha256")
    .update("tutti:chrome-stable-profile:v1:\0")
    .update(directoryName)
    .digest("base64url");
}

function isSafeProfileDirectoryName(value: string): boolean {
  return (
    PROFILE_DIRECTORY_PATTERN.test(value) &&
    !isAbsolute(value) &&
    basename(value) === value
  );
}

function isImmediateChild(parent: string, child: string): boolean {
  const segment = relative(parent, child);
  return segment.length > 0 && basename(segment) === segment;
}

function isPathInside(parent: string, child: string): boolean {
  const segment = relative(parent, child);
  return (
    segment.length > 0 && !segment.startsWith("..") && !isAbsolute(segment)
  );
}

function isPartitionedCookie(row: ChromeCookieRow): boolean {
  return (
    Boolean(stringValue(row.top_frame_site_key)) ||
    Boolean(stringValue(row.partition_key)) ||
    booleanInteger(row.is_partitioned)
  );
}

function chromeTimestampToUnixSeconds(
  value: number | bigint | string | null
): number {
  const numeric = Number(value);
  return numeric / 1_000_000 - CHROME_COOKIE_EPOCH_OFFSET_SECONDS;
}

function chromeSameSite(
  value: number | bigint | string | null
): PreparedChromeCookie["sameSite"] {
  switch (integerValue(value)) {
    case 0:
      return "no_restriction";
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
}

function bufferValue(value: Uint8Array | null): Buffer {
  return value instanceof Uint8Array ? Buffer.from(value) : Buffer.alloc(0);
}

function booleanInteger(value: unknown): boolean {
  return Number(value) === 1;
}

function integerValue(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
