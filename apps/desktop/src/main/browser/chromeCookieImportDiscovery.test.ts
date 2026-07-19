import assert from "node:assert/strict";
import test from "node:test";
import { createChromeCookieProfileDiscovery } from "./chromeCookieImportDiscovery.ts";

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
