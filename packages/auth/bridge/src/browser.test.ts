import assert from "node:assert/strict";
import test from "node:test";
import { createTuttiBrowserAuthClient } from "./browser";
import { DEFAULT_APP_ID } from "./shared";

test("browser login redirects in-place by default", () => {
  const assigned: string[] = [];
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        pathname: "/room/1",
        search: "?tab=tasks",
        hash: "#top",
        assign: (url: string) => assigned.push(url)
      }
    }
  });

  try {
    createTuttiBrowserAuthClient().login();
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow
    });
  }

  const url = new URL(assigned[0]);
  assert.equal(url.toString().startsWith("https://tutti.sh/auth/login?"), true);
  assert.equal(url.searchParams.get("redirect_uri"), "/room/1?tab=tasks#top");
});

test("browser getUserInfo returns user and nulls unauthorized sessions", async () => {
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({ code: 0, data: { user_id: "user-1", name: "Alice" } }),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ code: 401, errmsg: "Unauthorized" }), {
      status: 401
    });
  }) as typeof fetch;

  try {
    const auth = createTuttiBrowserAuthClient();
    assert.deepEqual(await auth.getUserInfo(), {
      userId: "user-1",
      name: "Alice",
      email: undefined,
      assetUrl: undefined,
      assetRef: undefined
    });
    assert.equal(await auth.getUserInfo(), null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("browser logout calls account logout endpoint", async () => {
  const previousFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(
      String(input),
      "https://tutti.sh/api/account/auth/v1/logout-web-session"
    );
    requestBody = String(init?.body ?? "");
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    await createTuttiBrowserAuthClient().logout();
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(JSON.parse(requestBody), { appId: DEFAULT_APP_ID });
});
