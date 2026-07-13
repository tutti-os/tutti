import assert from "node:assert/strict";
import test from "node:test";
import { createPrimaryWindowAnalyticsClaim } from "./primaryWindowAnalyticsClaim.ts";

test("primary window analytics claim grants ownership only once", () => {
  const claim = createPrimaryWindowAnalyticsClaim();

  assert.equal(claim.claim(), true);
  assert.equal(claim.claim(), false);
  assert.equal(claim.claim(), false);
});

test("primary window analytics claims are isolated by desktop process", () => {
  const firstProcessClaim = createPrimaryWindowAnalyticsClaim();
  const secondProcessClaim = createPrimaryWindowAnalyticsClaim();

  assert.equal(firstProcessClaim.claim(), true);
  assert.equal(firstProcessClaim.claim(), false);
  assert.equal(secondProcessClaim.claim(), true);
});
