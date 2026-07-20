import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";
import {
  formatAgentProviderUpdateSummary,
  resolveAgentProviderUpdateRowPresentation
} from "./workspaceAgentsSettingsUpdateModel.ts";

test("update summary stays compact for available and up-to-date states", () => {
  const t = ((key: string, values?: Record<string, string>) => {
    if (key.endsWith("updateAvailableSummary")) {
      return `${values?.current} → ${values?.latest}`;
    }
    if (key.endsWith("updateUpToDateSummary")) {
      return `${values?.current} · Up to date`;
    }
    if (key.endsWith("currentVersionSummary")) {
      return values?.current ?? "";
    }
    return key;
  }) as import("@renderer/i18n").TranslateFn;

  assert.equal(
    formatAgentProviderUpdateSummary({
      checkFailed: false,
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      t,
      updateAvailable: true
    }),
    "1.0.0 → 1.1.0"
  );
  assert.equal(
    formatAgentProviderUpdateSummary({
      checkFailed: false,
      currentVersion: "1.1.0",
      latestVersion: "1.1.0",
      t,
      updateAvailable: false
    }),
    "1.1.0 · Up to date"
  );
  assert.equal(
    formatAgentProviderUpdateSummary({
      checkFailed: false,
      currentVersion: "1.0.0",
      latestVersion: null,
      t,
      updateAvailable: false
    }),
    "1.0.0"
  );
});

test("update summary surfaces a non-fatal discovery failure", () => {
  const status = createStatus({
    actions: [],
    update: {
      capability: "supported",
      currentVersion: "1.0.0",
      lastCheckedAt: "2026-07-19T00:00:00.000Z",
      latestVersion: null,
      reasonCode: "update_check_failed",
      source: "npm",
      unsupportedReason: null,
      updateAvailable: null
    }
  });
  const presentation = resolveAgentProviderUpdateRowPresentation(status);
  const t = ((key: string, values?: Record<string, string>) =>
    key.endsWith("updateCheckFailedSummary")
      ? `${values?.current} · Check failed`
      : key) as import("@renderer/i18n").TranslateFn;

  assert.equal(presentation.checkFailed, true);
  assert.equal(
    formatAgentProviderUpdateSummary({
      checkFailed: presentation.checkFailed,
      currentVersion: presentation.currentVersion,
      latestVersion: presentation.latestVersion,
      t,
      updateAvailable: presentation.updateAvailable
    }),
    "1.0.0 · Check failed"
  );
});

function createStatus(input: {
  actions: AgentProviderStatus["actions"];
  update: AgentProviderStatus["update"];
}): AgentProviderStatus {
  return {
    actions: input.actions,
    adapter: { command: ["codex"], installed: true },
    auth: { status: "authenticated" },
    availability: { status: "ready" },
    cli: { installed: true, version: input.update.currentVersion },
    provider: "codex",
    update: input.update
  };
}
