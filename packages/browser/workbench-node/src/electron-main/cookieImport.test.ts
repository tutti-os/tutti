import assert from "node:assert/strict";
import test from "node:test";
import {
  importBrowserGuestCookies,
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

  assert.deepEqual(result, { canceled: false, imported: 1, skipped: 1 });
  assert.equal(stored[0]?.name, "accepted");
  assert.equal(flushCalls, 1);
});
