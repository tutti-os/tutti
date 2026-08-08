import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { setOutboundFetcherForTesting } from "./net/outboundFetch.ts";
import { probeCodeBuddyProvider } from "./codeBuddyProviderUsageProbe.ts";

const ORIGINAL_ENVIRONMENT = {
  CODEBUDDY_API_KEY: process.env.CODEBUDDY_API_KEY,
  CODEBUDDY_AUTH_TOKEN: process.env.CODEBUDDY_AUTH_TOKEN,
  CODEBUDDY_BASE_URL: process.env.CODEBUDDY_BASE_URL,
  CODEBUDDY_CONFIG_DIR: process.env.CODEBUDDY_CONFIG_DIR,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  HOME: process.env.HOME
};

afterEach(() => {
  setOutboundFetcherForTesting(null);
  for (const [name, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    restoreEnvironment(name, value);
  }
});

test("probeCodeBuddyProvider reports ordinary API-key billing without projecting the key", async () => {
  const home = await createIsolatedCodeBuddyHome({
    env: {
      CODEBUDDY_API_KEY: "sk-api-must-not-be-projected",
      CODEBUDDY_BASE_URL: "https://api.example.test/v1"
    }
  });
  try {
    const result = await probeCodeBuddyProvider(
      {
        includeUsage: true,
        providers: ["acp:codebuddy"],
        refresh: true,
        workspaceId: "workspace-1"
      },
      500
    );

    assert.equal(result.availability.status, "available");
    assert.deepEqual(result.usage, {
      billingMode: "api",
      capturedAtUnixMs: 500,
      quotas: []
    });
    assert.equal(
      JSON.stringify(result).includes("sk-api-must-not-be-projected"),
      false
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("probeCodeBuddyProvider distinguishes a Coding Plan key", async () => {
  const home = await createIsolatedCodeBuddyHome({
    env: {
      CODEBUDDY_API_KEY: "sk-sp-must-not-be-projected",
      CODEBUDDY_BASE_URL: "https://api.lkeap.cloud.tencent.com/coding/anthropic"
    }
  });
  try {
    const result = await probeCodeBuddyProvider(
      {
        includeUsage: true,
        providers: ["acp:codebuddy"],
        refresh: true,
        workspaceId: "workspace-1"
      },
      600
    );

    assert.equal(result.availability.status, "available");
    assert.deepEqual(result.usage, {
      billingMode: "subscription",
      capturedAtUnixMs: 600,
      quotas: []
    });
    assert.equal(
      JSON.stringify(result).includes("sk-sp-must-not-be-projected"),
      false
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("probeCodeBuddyProvider treats platform bearer authentication as a provider account", async () => {
  const home = await createIsolatedCodeBuddyHome({
    env: { CODEBUDDY_AUTH_TOKEN: "bearer-must-not-be-projected" }
  });
  try {
    const result = await probeCodeBuddyProvider(
      {
        includeUsage: true,
        providers: ["acp:codebuddy"],
        refresh: true,
        workspaceId: "workspace-1"
      },
      700
    );

    assert.equal(result.usage?.billingMode, "provider_account");
    assert.equal(
      JSON.stringify(result).includes("bearer-must-not-be-projected"),
      false
    );
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("probeCodeBuddyProvider detects CodeBuddy's native stored login without projecting it", async () => {
  const home = await createIsolatedCodeBuddyHome({});
  try {
    const authDirectory = codeBuddyNativeAuthDirectory(home);
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      join(authDirectory, "Tencent-Cloud.coding-copilot.info"),
      JSON.stringify({
        account: { uid: "test-user-id" },
        auth: {
          accessToken: "stored-token-must-not-be-projected",
          domain: "www.codebuddy.cn",
          expiresAt: 4_102_444_800_000
        }
      })
    );
    setOutboundFetcherForTesting(async (url, init) => {
      assert.equal(
        url,
        "https://copilot.tencent.com/billing/meter/get-user-resource"
      );
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(
        headers.get("authorization"),
        "Bearer stored-token-must-not-be-projected"
      );
      assert.equal(headers.get("x-user-id"), "test-user-id");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.ProductCode, "p_tcaca");
      assert.deepEqual(body.Status, [0, 3]);
      assert.equal(body.PageNumber, 1);
      assert.equal(body.PageSize, 200);
      assert.ok(Array.isArray(body.PackageCodes));
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            Response: {
              Data: {
                Accounts: [
                  {
                    CapacityRemainPrecise: "500",
                    CapacitySizePrecise: "500",
                    Status: 0
                  },
                  {
                    CapacityRemainPrecise: 1_600,
                    CapacitySizePrecise: 1_600,
                    Status: 3
                  },
                  {
                    CapacityRemainPrecise: 9_999,
                    CapacitySizePrecise: 9_999,
                    Status: 1
                  }
                ]
              }
            }
          }
        }),
        { status: 200 }
      );
    });

    const result = await probeCodeBuddyProvider(
      {
        includeUsage: true,
        providers: ["acp:codebuddy"],
        refresh: true,
        workspaceId: "workspace-1"
      },
      800
    );

    assert.equal(result.usage?.billingMode, "provider_account");
    assert.deepEqual(result.usage?.quotas, [
      {
        amountLimit: 2_100,
        amountRemaining: 2_100,
        amountUnit: "credits",
        percentRemaining: 100,
        quotaType: "credits"
      }
    ]);
    assert.equal(
      result.attempts?.some(
        (attempt) =>
          attempt.strategy === "codebuddy-account-credits" && attempt.success
      ),
      true
    );
    assert.equal(
      JSON.stringify(result).includes("stored-token-must-not-be-projected"),
      false
    );
    assert.equal(JSON.stringify(result).includes("test-user-id"), false);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("probeCodeBuddyProvider keeps account availability when the credit request is unauthorized", async () => {
  const home = await createIsolatedCodeBuddyHome({});
  try {
    const authDirectory = codeBuddyNativeAuthDirectory(home);
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      join(authDirectory, "Tencent-Cloud.coding-copilot.info"),
      JSON.stringify({
        account: { uid: "test-user-id" },
        auth: {
          accessToken: "stale-token-must-not-be-projected",
          domain: "www.codebuddy.cn",
          expiresAt: 4_102_444_800_000
        }
      })
    );
    setOutboundFetcherForTesting(
      async () => new Response("unauthorized", { status: 401 })
    );

    const result = await probeCodeBuddyProvider(
      {
        includeUsage: true,
        providers: ["acp:codebuddy"],
        refresh: true,
        workspaceId: "workspace-1"
      },
      900
    );

    assert.equal(result.availability.status, "available");
    assert.equal(result.usage?.billingMode, "provider_account");
    assert.equal(result.lastError?.code, "session_expired");
    assert.equal(
      JSON.stringify(result).includes("stale-token-must-not-be-projected"),
      false
    );
    assert.equal(JSON.stringify(result).includes("test-user-id"), false);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

async function createIsolatedCodeBuddyHome(
  settings: Record<string, unknown>
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tutti-codebuddy-account-"));
  process.env.HOME = home;
  process.env.CODEBUDDY_CONFIG_DIR = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  delete process.env.CODEBUDDY_API_KEY;
  delete process.env.CODEBUDDY_AUTH_TOKEN;
  delete process.env.CODEBUDDY_BASE_URL;
  await writeFile(join(home, "settings.json"), JSON.stringify(settings));
  return home;
}

function codeBuddyNativeAuthDirectory(home: string): string {
  if (process.platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth"
    );
  }
  if (process.platform === "win32") {
    return join(
      home,
      "AppData",
      "Roaming",
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth"
    );
  }
  return join(home, ".config", "CodeBuddyExtension", "Data", "Public", "auth");
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
