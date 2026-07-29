import type {
  BrowserNodeChromeCookieImportInput,
  BrowserNodeCookieImportResult,
  BrowserNodeSessionMode
} from "../core/types.ts";
import { importPreparedBrowserGuestCookies } from "./cookieImport.ts";
import type {
  BrowserGuestCookieStore,
  BrowserGuestElectronSession,
  BrowserGuestWebContents,
  BrowserNodeChromeCookiePreparationResult
} from "./types.ts";

export function getBrowserGuestCookieImportSession(
  contents: BrowserGuestWebContents | null | undefined
): BrowserGuestElectronSession | null {
  return contents && !contents.isDestroyed()
    ? (contents.session ?? null)
    : null;
}

function isBrowserGuestCookieReloadUrl(
  url: string | null | undefined
): boolean {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0 || trimmed === "about:blank") {
    return false;
  }
  try {
    const protocol = new URL(trimmed).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function reloadBrowserGuestsForCookieSession(
  browserSessions: Iterable<{
    contents: BrowserGuestWebContents | null;
    sessionMode: BrowserNodeSessionMode;
    sessionPartition: string | null;
  }>,
  target: BrowserGuestElectronSession
): void {
  for (const browserSession of browserSessions) {
    const contents = browserSession.contents;
    if (
      browserSession.sessionMode !== "incognito" &&
      browserSession.sessionPartition === null &&
      contents &&
      !contents.isDestroyed() &&
      contents.session === target &&
      isBrowserGuestCookieReloadUrl(contents.getURL?.() ?? null)
    ) {
      contents.reload();
    }
  }
}

export async function importChromeCookiesIntoBrowserGuest(input: {
  contents: BrowserGuestWebContents | null | undefined;
  cookieStore?: BrowserGuestCookieStore | null;
  importInput: BrowserNodeChromeCookieImportInput;
  prepareChromeCookieImport?: (
    profileId: BrowserNodeChromeCookieImportInput["profileId"],
    signal: AbortSignal
  ) => Promise<BrowserNodeChromeCookiePreparationResult>;
  signal: AbortSignal;
  sessionMode: BrowserNodeSessionMode;
  sessionPartition: string | null;
}): Promise<BrowserNodeCookieImportResult> {
  const store =
    input.cookieStore ??
    (input.contents && !input.contents.isDestroyed()
      ? (input.contents.session?.cookies ?? null)
      : null);
  if (
    !store ||
    input.sessionMode === "incognito" ||
    input.sessionPartition !== null ||
    !input.prepareChromeCookieImport
  ) {
    return failedChromeImport("profile", "invalid-target");
  }

  const prepared = await input.prepareChromeCookieImport(
    input.importInput.profileId,
    input.signal
  );
  if (prepared.status === "canceled" || input.signal.aborted) {
    return {
      canceled: true,
      failed: 0,
      imported: 0,
      partial: false,
      skipped: 0,
      status: "canceled"
    };
  }
  if (prepared.status === "failed") {
    return failedChromeImport(prepared.failureStage, prepared.failureCode);
  }
  return importPreparedBrowserGuestCookies(store, prepared);
}

function failedChromeImport(
  failureStage: import("../core/types.ts").BrowserNodeCookieImportFailureStage,
  failureCode: string
): BrowserNodeCookieImportResult {
  return {
    canceled: false,
    failed: 0,
    failureCode,
    failureStage,
    imported: 0,
    partial: false,
    skipped: 0,
    status: "failed"
  };
}
