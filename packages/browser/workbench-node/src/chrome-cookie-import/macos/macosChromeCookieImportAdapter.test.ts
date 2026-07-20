import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserNodeChromeProfileId } from "../../core/types.ts";
import {
  createChromeCookieProfileDiscovery,
  createMacosChromeCookieImportAdapter,
  createMacosChromeCookieImportAdapterWithDependencies
} from "./macosChromeCookieImportAdapter.ts";
import { ChromeCookieImportError } from "./chromeCookieImport.ts";

test("Chrome Profile auto-discovery runs at most once per app registration", async () => {
  let calls = 0;
  const discover = createChromeCookieProfileDiscovery({
    async discoverProfiles() {
      calls += 1;
      return [{ id: "opaque", name: "Default" }];
    },
    isEnabled: () => true,
    platform: "darwin"
  });

  const [first, second, third] = await Promise.all([
    discover(),
    discover(),
    discover()
  ]);

  assert.equal(calls, 1);
  assert.equal(first.status, "available");
  assert.equal(first, second);
  assert.equal(second, third);
});

test("Chrome Profile discovery reports unsupported, disabled, empty, and failed states", async () => {
  const unavailableDiscovery = (input: {
    discoverProfiles(): Promise<never[]>;
    isEnabled(): boolean;
    platform: NodeJS.Platform;
  }) => createChromeCookieProfileDiscovery(input);
  const unsupported = unavailableDiscovery({
    discoverProfiles: async () => {
      throw new Error("must not run");
    },
    isEnabled: () => true,
    platform: "linux"
  });
  const disabled = unavailableDiscovery({
    discoverProfiles: async () => {
      throw new Error("must not run");
    },
    isEnabled: () => false,
    platform: "darwin"
  });
  const empty = unavailableDiscovery({
    discoverProfiles: async () => [],
    isEnabled: () => true,
    platform: "darwin"
  });
  const failed = unavailableDiscovery({
    discoverProfiles: async () => {
      throw new Error("failed");
    },
    isEnabled: () => true,
    platform: "darwin"
  });

  assert.deepEqual(await unsupported(), {
    reason: "unsupported-platform",
    status: "unavailable"
  });
  assert.deepEqual(await disabled(), {
    reason: "disabled",
    status: "unavailable"
  });
  assert.deepEqual(await empty(), {
    reason: "no-profiles",
    status: "unavailable"
  });
  assert.deepEqual(await failed(), {
    reason: "unavailable",
    status: "unavailable"
  });
});

test("macOS adapter rejects unsupported and disabled preparation before host access", async () => {
  const profileId = "opaque" as BrowserNodeChromeProfileId;
  const unsupported = createMacosChromeCookieImportAdapter({
    isEnabled: () => true,
    platform: "linux"
  });
  const disabled = createMacosChromeCookieImportAdapter({
    isEnabled: () => false,
    platform: "darwin"
  });

  assert.deepEqual(
    await unsupported.prepareChromeCookieImport(
      profileId,
      new AbortController().signal
    ),
    {
      failureCode: "unsupported-platform",
      failureStage: "profile",
      status: "failed"
    }
  );
  assert.deepEqual(
    await disabled.prepareChromeCookieImport(
      profileId,
      new AbortController().signal
    ),
    {
      failureCode: "disabled",
      failureStage: "profile",
      status: "failed"
    }
  );
});

test("macOS adapter exposes prepared fixture Cookies through the Browser host contract", async () => {
  const profileId = "opaque" as BrowserNodeChromeProfileId;
  const adapter = createMacosChromeCookieImportAdapterWithDependencies(
    { isEnabled: () => true, platform: "darwin" },
    {
      discoverProfiles: async () => [{ id: profileId, name: "Default" }],
      prepareCookies: async (actualProfileId) => {
        assert.equal(actualProfileId, profileId);
        return {
          cookies: [
            {
              httpOnly: true,
              name: "session",
              path: "/",
              sameSite: "lax",
              secure: true,
              url: "https://example.test/",
              value: "fixture-value"
            }
          ],
          databaseVersion: 24,
          skipped: 2
        };
      }
    }
  );

  assert.deepEqual(
    await adapter.prepareChromeCookieImport(
      profileId,
      new AbortController().signal
    ),
    {
      cookies: [
        {
          httpOnly: true,
          name: "session",
          path: "/",
          sameSite: "lax",
          secure: true,
          url: "https://example.test/",
          value: "fixture-value"
        }
      ],
      skipped: 2,
      status: "ready"
    }
  );
});

test("macOS adapter classifies failures without logging Profile or Cookie data", async () => {
  const profileId = "secret-profile-id" as BrowserNodeChromeProfileId;
  const warnings: Array<{
    message: string;
    metadata?: Record<string, unknown>;
  }> = [];
  const adapter = createMacosChromeCookieImportAdapterWithDependencies(
    {
      isEnabled: () => true,
      logger: {
        warn(message, metadata) {
          warnings.push({ message, metadata });
        }
      },
      platform: "darwin"
    },
    {
      discoverProfiles: async () => [],
      prepareCookies: async () => {
        throw new ChromeCookieImportError("keychain_denied");
      }
    }
  );

  assert.deepEqual(
    await adapter.prepareChromeCookieImport(
      profileId,
      new AbortController().signal
    ),
    {
      failureCode: "keychain_denied",
      failureStage: "keychain",
      status: "failed"
    }
  );
  assert.deepEqual(warnings, [
    {
      message: "Chrome Cookie import preparation failed",
      metadata: { code: "keychain_denied", stage: "keychain" }
    }
  ]);
  assert.equal(JSON.stringify(warnings).includes(profileId), false);
});

test("macOS adapter reports cancellation without logging a failure", async () => {
  const profileId = "opaque" as BrowserNodeChromeProfileId;
  const controller = new AbortController();
  let warningCount = 0;
  const adapter = createMacosChromeCookieImportAdapterWithDependencies(
    {
      isEnabled: () => true,
      logger: {
        warn() {
          warningCount += 1;
        }
      },
      platform: "darwin"
    },
    {
      discoverProfiles: async () => [],
      prepareCookies: async (_profileId, signal) => {
        controller.abort();
        signal.throwIfAborted();
        throw new Error("unreachable");
      }
    }
  );

  assert.deepEqual(
    await adapter.prepareChromeCookieImport(profileId, controller.signal),
    { status: "canceled" }
  );
  assert.equal(warningCount, 0);
});
