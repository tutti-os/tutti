import type {
  BrowserGuestCookieDetails,
  BrowserGuestWebContents,
  BrowserNodeCookieImportSource
} from "./types.ts";
import type { BrowserNodeCookieImportResult } from "../core/types.ts";

interface ParsedCookieImport {
  cookies: BrowserGuestCookieDetails[];
  skipped: number;
}

export async function importBrowserGuestCookies(
  contents: BrowserGuestWebContents | null | undefined,
  source: BrowserNodeCookieImportSource | null
): Promise<BrowserNodeCookieImportResult> {
  if (source === null) {
    return { canceled: true, imported: 0, skipped: 0 };
  }
  const store = contents?.session?.cookies;
  if (!contents || contents.isDestroyed() || !store) {
    return { canceled: false, imported: 0, skipped: 0 };
  }

  const parsed = parseBrowserCookieImport(source.contents);
  let imported = 0;
  let skipped = parsed.skipped;
  for (const cookie of parsed.cookies) {
    try {
      await store.set(cookie);
      imported += 1;
    } catch {
      skipped += 1;
    }
  }
  await store.flushStore?.();
  return { canceled: false, imported, skipped };
}

export function parseBrowserCookieImport(contents: string): ParsedCookieImport {
  const trimmed = contents.trim();
  if (trimmed.length === 0) {
    return { cookies: [], skipped: 0 };
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return parseJsonCookies(trimmed);
  }
  return parseNetscapeCookies(trimmed);
}

function parseJsonCookies(contents: string): ParsedCookieImport {
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { cookies: [], skipped: 1 };
  }
  const entries: unknown[] | null = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { cookies?: unknown }).cookies)
      ? (raw as { cookies: unknown[] }).cookies
      : null;
  if (!entries) {
    return { cookies: [], skipped: 1 };
  }
  const cookies: BrowserGuestCookieDetails[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const cookie = normalizeJsonCookie(entry);
    if (cookie) {
      cookies.push(cookie);
    } else {
      skipped += 1;
    }
  }
  return { cookies, skipped };
}

function normalizeJsonCookie(value: unknown): BrowserGuestCookieDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const name = readString(entry.name);
  const cookieValue = readString(entry.value, true);
  const explicitUrl = readString(entry.url);
  const domain = readString(entry.domain);
  const secure = entry.secure === true;
  const url =
    explicitUrl ?? buildCookieUrl(domain, secure, readString(entry.path));
  if (!name || cookieValue === null || !url) {
    return null;
  }
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  const expirationDate = readFiniteNumber(
    entry.expirationDate ?? entry.expiration ?? entry.expires
  );
  return {
    ...(domain ? { domain } : {}),
    ...(expirationDate && expirationDate > 0 ? { expirationDate } : {}),
    ...(entry.httpOnly === true ? { httpOnly: true } : {}),
    name,
    path: normalizeCookiePath(readString(entry.path)),
    ...(normalizeSameSite(entry.sameSite)
      ? { sameSite: normalizeSameSite(entry.sameSite)! }
      : {}),
    secure,
    url,
    value: cookieValue
  };
}

function parseNetscapeCookies(contents: string): ParsedCookieImport {
  const cookies: BrowserGuestCookieDetails[] = [];
  let skipped = 0;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      line.length === 0 ||
      (line.startsWith("#") && !line.startsWith("#HttpOnly_"))
    ) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length < 7) {
      skipped += 1;
      continue;
    }
    const httpOnly = fields[0]!.startsWith("#HttpOnly_");
    const domain = fields[0]!.replace(/^#HttpOnly_/, "");
    const path = normalizeCookiePath(fields[2]);
    const secure = fields[3]?.toUpperCase() === "TRUE";
    const name = fields[5]?.trim() ?? "";
    const value = fields.slice(6).join("\t");
    const url = buildCookieUrl(domain, secure, path);
    if (!domain || !name || !url) {
      skipped += 1;
      continue;
    }
    const expirationDate = readFiniteNumber(fields[4]);
    cookies.push({
      domain,
      ...(expirationDate && expirationDate > 0 ? { expirationDate } : {}),
      ...(httpOnly ? { httpOnly: true } : {}),
      name,
      path,
      secure,
      url,
      value
    });
  }
  return { cookies, skipped };
}

function buildCookieUrl(
  domain: string | null | undefined,
  secure: boolean,
  path: string | null | undefined
): string | null {
  const hostname = domain?.replace(/^\./, "");
  if (!hostname || /[\s/:]/.test(hostname)) {
    return null;
  }
  return `${secure ? "https" : "http"}://${hostname}${normalizeCookiePath(path)}`;
}

function normalizeCookiePath(path: string | null | undefined): string {
  return path?.startsWith("/") ? path : "/";
}

function normalizeSameSite(
  value: unknown
): BrowserGuestCookieDetails["sameSite"] | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.toLowerCase().replace(/[- ]/g, "_")) {
    case "lax":
      return "lax";
    case "none":
    case "no_restriction":
      return "no_restriction";
    case "strict":
      return "strict";
    case "unspecified":
      return "unspecified";
    default:
      return null;
  }
}

function readString(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 || allowEmpty ? normalized : null;
}

function readFiniteNumber(value: unknown): number | null {
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}
