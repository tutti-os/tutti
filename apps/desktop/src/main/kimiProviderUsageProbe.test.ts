import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { probeKimiCodeProvider } from "./kimiProviderUsageProbe.ts";
import { setOutboundFetcherForTesting } from "./net/outboundFetch.ts";

afterEach(() => {
  setOutboundFetcherForTesting(null);
});

test("probeKimiCodeProvider maps Coding Plan quota windows", async () => {
  const home = await mkdtemp(join(tmpdir(), "tutti-kimi-plan-"));
  const previousHome = process.env.KIMI_CODE_HOME;
  const previousModel = process.env.KIMI_MODEL_NAME;
  try {
    process.env.KIMI_CODE_HOME = home;
    delete process.env.KIMI_MODEL_NAME;
    await mkdir(join(home, "credentials"), { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      `default_model = "kimi-code/kimi-for-coding"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"

[providers."managed:kimi-code"]
base_url = "https://api.kimi.test/coding/v1/"
oauth = { storage = "file", key = "oauth/kimi-code" }
`
    );
    await writeFile(
      join(home, "credentials", "kimi-code.json"),
      JSON.stringify({
        access_token: "test-access-token",
        expires_at: 4_102_444_800
      })
    );
    setOutboundFetcherForTesting(async (url, init) => {
      assert.equal(url, "https://api.kimi.test/coding/v1/usages");
      assert.deepEqual(init?.headers, {
        Accept: "application/json",
        Authorization: "Bearer test-access-token"
      });
      return new Response(
        JSON.stringify({
          usage: {
            limit: 1_000,
            name: "Weekly limit",
            resetAt: "2026-08-14T08:00:00.000Z",
            used: 250
          },
          limits: [
            {
              detail: { limit: 100, remaining: 90 },
              window: { duration: 300, timeUnit: "MINUTE" }
            }
          ]
        }),
        { status: 200 }
      );
    });

    const result = await probeKimiCodeProvider(
      {
        includeUsage: true,
        providers: ["acp:kimi-code"],
        refresh: true,
        workspaceId: "workspace-1"
      },
      1_786_090_000_000
    );

    assert.equal(result.availability.status, "available");
    assert.equal(result.usage?.billingMode, "subscription");
    assert.deepEqual(result.usage?.quotas, [
      {
        percentRemaining: 75,
        quotaType: "weekly",
        resetsAtUnixMs: 1786694400000
      },
      { percentRemaining: 90, quotaType: "session" }
    ]);
  } finally {
    restoreEnvironment("KIMI_CODE_HOME", previousHome);
    restoreEnvironment("KIMI_MODEL_NAME", previousModel);
    await rm(home, { force: true, recursive: true });
  }
});

test("probeKimiCodeProvider reports API billing without reading an API key", async () => {
  const home = await mkdtemp(join(tmpdir(), "tutti-kimi-api-"));
  const previousHome = process.env.KIMI_CODE_HOME;
  const previousModel = process.env.KIMI_MODEL_NAME;
  try {
    process.env.KIMI_CODE_HOME = home;
    delete process.env.KIMI_MODEL_NAME;
    await writeFile(
      join(home, "config.toml"),
      `default_model = "custom.kimi"

[models."custom.kimi"]
provider = "moonshot-api"

[providers."moonshot-api"]
type = "kimi"
base_url = "https://api.moonshot.ai/v1"
api_key = "must-not-be-projected"
`
    );
    setOutboundFetcherForTesting(async () => {
      throw new Error("API billing must not call the Coding Plan endpoint");
    });

    const result = await probeKimiCodeProvider(
      {
        includeUsage: true,
        providers: ["acp:kimi-code"],
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
      JSON.stringify(result).includes("must-not-be-projected"),
      false
    );
  } finally {
    restoreEnvironment("KIMI_CODE_HOME", previousHome);
    restoreEnvironment("KIMI_MODEL_NAME", previousModel);
    await rm(home, { force: true, recursive: true });
  }
});

test("probeKimiCodeProvider classifies expired Coding Plan credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "tutti-kimi-expired-"));
  const previousHome = process.env.KIMI_CODE_HOME;
  const previousModel = process.env.KIMI_MODEL_NAME;
  try {
    process.env.KIMI_CODE_HOME = home;
    delete process.env.KIMI_MODEL_NAME;
    await mkdir(join(home, "credentials"), { recursive: true });
    await writeFile(
      join(home, "config.toml"),
      `default_model = "kimi-code/kimi-for-coding"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
`
    );
    await writeFile(
      join(home, "credentials", "kimi-code.json"),
      JSON.stringify({ access_token: "expired-token", expires_at: 1 })
    );

    const result = await probeKimiCodeProvider(
      {
        includeUsage: true,
        providers: ["acp:kimi-code"],
        refresh: true,
        workspaceId: "workspace-1"
      },
      500
    );

    assert.equal(result.availability.status, "unavailable");
    assert.equal(result.lastError?.code, "session_expired");
    assert.equal(JSON.stringify(result).includes("expired-token"), false);
  } finally {
    restoreEnvironment("KIMI_CODE_HOME", previousHome);
    restoreEnvironment("KIMI_MODEL_NAME", previousModel);
    await rm(home, { force: true, recursive: true });
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
