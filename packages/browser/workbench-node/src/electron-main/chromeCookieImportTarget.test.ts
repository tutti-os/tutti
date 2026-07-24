import assert from "node:assert/strict";
import test from "node:test";
import {
  importChromeCookiesIntoBrowserGuest,
  reloadBrowserGuestsForCookieSession
} from "./chromeCookieImportTarget.ts";
import type {
  BrowserGuestCookieDetails,
  BrowserGuestCookieStore,
  BrowserGuestElectronSession,
  BrowserGuestWebContents
} from "./types.ts";

test("cookie session reload skips blank guests and refreshes real pages", () => {
  const sharedSession = {
    id: "shared"
  } as unknown as BrowserGuestElectronSession;
  const blank = {
    getURL: () => "about:blank",
    isDestroyed: () => false,
    reloadCalls: 0,
    reload() {
      this.reloadCalls += 1;
    },
    session: sharedSession
  };
  const page = {
    getURL: () => "https://example.test/app",
    isDestroyed: () => false,
    reloadCalls: 0,
    reload() {
      this.reloadCalls += 1;
    },
    session: sharedSession
  };

  reloadBrowserGuestsForCookieSession(
    [
      {
        contents: blank as unknown as BrowserGuestWebContents,
        sessionMode: "shared",
        sessionPartition: null
      },
      {
        contents: page as unknown as BrowserGuestWebContents,
        sessionMode: "shared",
        sessionPartition: null
      }
    ],
    sharedSession
  );

  assert.equal(blank.reloadCalls, 0);
  assert.equal(page.reloadCalls, 1);
});

test("Chrome Cookie import can target an ordinary Cookie store without a live guest", async () => {
  const cookies: BrowserGuestCookieDetails[] = [];
  const cookieStore = {
    async set(cookie: BrowserGuestCookieDetails) {
      cookies.push(cookie);
    }
  } as BrowserGuestCookieStore;

  const result = await importChromeCookiesIntoBrowserGuest({
    contents: null,
    cookieStore,
    importInput: {
      nodeId: "home-browser",
      operationId: "operation-home",
      profileId: "opaque" as never
    },
    prepareChromeCookieImport: async () => ({
      cookies: [
        {
          name: "session",
          url: "https://example.test/",
          value: "one"
        }
      ],
      skipped: 0,
      status: "ready"
    }),
    signal: new AbortController().signal,
    sessionMode: "shared",
    sessionPartition: null
  });

  assert.equal(result.status, "completed");
  assert.equal(result.imported, 1);
  assert.equal(cookies.length, 1);
});
