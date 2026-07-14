import assert from "node:assert/strict";
import test from "node:test";
import {
  activeProviderNotReadyRecheckKey,
  shouldSuppressAgentProviderNotReadyProjection
} from "./desktopAgentProviderNotReadyRecheck.ts";

test("activeProviderNotReadyRecheckKey ignores ready and missing statuses", () => {
  assert.equal(
    activeProviderNotReadyRecheckKey({
      availabilityStatus: "ready",
      provider: "cursor"
    }),
    null
  );
  assert.equal(
    activeProviderNotReadyRecheckKey({
      availabilityStatus: null,
      provider: "cursor"
    }),
    null
  );
  assert.equal(
    activeProviderNotReadyRecheckKey({
      availabilityStatus: "missing",
      provider: "cursor"
    }),
    null
  );
});

test("activeProviderNotReadyRecheckKey keys not-ready statuses per provider", () => {
  assert.equal(
    activeProviderNotReadyRecheckKey({
      availabilityStatus: "auth_required",
      provider: "cursor"
    }),
    "cursor:auth_required"
  );
  assert.equal(
    activeProviderNotReadyRecheckKey({
      availabilityStatus: "not_installed",
      provider: "codex"
    }),
    "codex:not_installed"
  );
});

test("shouldSuppressAgentProviderNotReadyProjection hides notice until recheck settles", () => {
  assert.equal(
    shouldSuppressAgentProviderNotReadyProjection({
      recheckKey: "cursor:auth_required",
      settledRecheckKey: null
    }),
    true
  );
  assert.equal(
    shouldSuppressAgentProviderNotReadyProjection({
      recheckKey: "cursor:auth_required",
      settledRecheckKey: "cursor:not_installed"
    }),
    true
  );
  assert.equal(
    shouldSuppressAgentProviderNotReadyProjection({
      recheckKey: "cursor:auth_required",
      settledRecheckKey: "cursor:auth_required"
    }),
    false
  );
  assert.equal(
    shouldSuppressAgentProviderNotReadyProjection({
      recheckKey: null,
      settledRecheckKey: null
    }),
    false
  );
});
