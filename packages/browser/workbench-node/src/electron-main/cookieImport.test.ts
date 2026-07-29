import assert from "node:assert/strict";
import test from "node:test";
import {
  importBrowserGuestCookies,
  importPreparedBrowserGuestCookies,
  parseBrowserCookieImport
} from "./cookieImport.ts";
import type {
  BrowserGuestCookieDetails,
  BrowserGuestWebContents
} from "./types.ts";

test("parses JSON Cookie exports without exposing values to diagnostics", () => {
  const parsed = parseBrowserCookieImport(
    JSON.stringify([
      {
        domain: ".example.com",
        expirationDate: 1_900_000_000,
        httpOnly: true,
        name: "session",
        path: "/account",
        sameSite: "no_restriction",
        secure: true,
        value: "secret"
      },
      { domain: "bad domain", name: "invalid", value: "x" }
    ])
  );

  assert.deepEqual(parsed, {
    cookies: [
      {
        domain: ".example.com",
        expirationDate: 1_900_000_000,
        httpOnly: true,
        name: "session",
        path: "/account",
        sameSite: "no_restriction",
        secure: true,
        url: "https://example.com/account",
        value: "secret"
      }
    ],
    skipped: 1
  });
});

test("preserves host-only session Cookies and Cookie value whitespace", () => {
  const parsed = parseBrowserCookieImport(
    JSON.stringify([
      {
        domain: "example.com",
        hostOnly: true,
        httpOnly: true,
        name: "session",
        sameSite: "lax",
        secure: true,
        value: "  secret value  "
      },
      {
        domain: "example.com",
        expirationDate: 1,
        name: "expired",
        value: "old"
      }
    ])
  );

  assert.deepEqual(parsed, {
    cookies: [
      {
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "lax",
        secure: true,
        url: "https://example.com/",
        value: "  secret value  "
      }
    ],
    skipped: 1
  });
});

test("parses Netscape Cookie files including HttpOnly entries", () => {
  const parsed = parseBrowserCookieImport(
    [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1900000000\tsession\tsecret",
      "invalid-row"
    ].join("\n")
  );

  assert.equal(parsed.cookies.length, 1);
  assert.deepEqual(parsed.cookies[0], {
    domain: ".example.com",
    expirationDate: 1_900_000_000,
    httpOnly: true,
    name: "session",
    path: "/",
    secure: true,
    url: "https://example.com/",
    value: "secret"
  });
  assert.equal(parsed.skipped, 1);
});

test("imports valid Cookies into only the active guest session", async () => {
  const stored: BrowserGuestCookieDetails[] = [];
  let flushCalls = 0;
  const contents = {
    isDestroyed: () => false,
    session: {
      cookies: {
        async flushStore() {
          flushCalls += 1;
        },
        async set(cookie: BrowserGuestCookieDetails) {
          if (cookie.name === "rejected") {
            throw new Error("rejected");
          }
          stored.push(cookie);
        }
      }
    }
  } as BrowserGuestWebContents;

  const result = await importBrowserGuestCookies(contents, {
    contents: JSON.stringify([
      { domain: "example.com", name: "accepted", value: "a" },
      { domain: "example.com", name: "rejected", value: "b" }
    ]),
    fileName: "cookies.json"
  });

  assert.deepEqual(result, {
    canceled: false,
    failed: 1,
    imported: 1,
    partial: true,
    skipped: 0,
    status: "completed"
  });
  assert.equal(stored[0]?.name, "accepted");
  assert.equal(flushCalls, 1);
});

test("prepared Cookie import merges by Electron Cookie identity", async () => {
  const values = new Map<string, string>();
  const store = {
    async set(cookie: BrowserGuestCookieDetails) {
      values.set(
        `${cookie.domain ?? new URL(cookie.url).hostname}|${cookie.path}|${cookie.name}`,
        cookie.value
      );
    }
  };

  await importPreparedBrowserGuestCookies(store, {
    cookies: [
      {
        domain: ".example.com",
        name: "login",
        path: "/",
        url: "https://example.com/",
        value: "old"
      }
    ],
    skipped: 0
  });
  await importPreparedBrowserGuestCookies(store, {
    cookies: [
      {
        domain: ".example.com",
        name: "login",
        path: "/",
        url: "https://example.com/",
        value: "new"
      }
    ],
    skipped: 0
  });

  assert.equal(values.size, 1);
  assert.equal(values.get(".example.com|/|login"), "new");
});

test("Cookie flush failure preserves completed writes as a partial result", async () => {
  const result = await importPreparedBrowserGuestCookies(
    {
      async flushStore() {
        throw new Error("flush failed");
      },
      async set() {}
    },
    {
      cookies: [
        {
          name: "login",
          url: "https://example.com/",
          value: "ready"
        }
      ],
      skipped: 0
    }
  );

  assert.deepEqual(result, {
    canceled: false,
    failed: 1,
    imported: 1,
    partial: true,
    skipped: 0,
    status: "completed"
  });
});
