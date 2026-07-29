import assert from "node:assert/strict";
import test from "node:test";
import { proxy } from "valtio";
import type { DesktopFeatureFlags } from "@shared/preferences";
import { bindDesktopAgentsEarlyAccessSync } from "./desktopAgentsEarlyAccessSync.ts";

async function flushValtio(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("early access sync seeds the current preference and reacts to changes", async () => {
  const store = proxy<{ featureFlags: DesktopFeatureFlags }>({
    featureFlags: { "lab.previewAgents": true }
  });
  const applied: boolean[] = [];
  const dispose = bindDesktopAgentsEarlyAccessSync({
    agentsService: {
      setEarlyAccessEnabled: (enabled) => applied.push(enabled)
    },
    preferencesStore: store
  });

  // Seeded synchronously from the current flag.
  assert.deepEqual(applied, [true]);

  store.featureFlags = { "lab.previewAgents": false };
  await flushValtio();
  assert.equal(applied.at(-1), false);

  store.featureFlags = { "lab.previewAgents": true };
  await flushValtio();
  assert.equal(applied.at(-1), true);

  dispose();
  store.featureFlags = { "lab.previewAgents": false };
  await flushValtio();
  // No further updates after disposing the subscription.
  assert.equal(applied.at(-1), true);
});

test("early access sync defaults to disabled when the flag is absent", () => {
  const store = proxy<{ featureFlags: DesktopFeatureFlags }>({
    featureFlags: {}
  });
  const applied: boolean[] = [];
  const dispose = bindDesktopAgentsEarlyAccessSync({
    agentsService: {
      setEarlyAccessEnabled: (enabled) => applied.push(enabled)
    },
    preferencesStore: store
  });
  assert.deepEqual(applied, [false]);
  dispose();
});
