import assert from "node:assert/strict";
import test from "node:test";
import { isAnalyticsDebugAvailable } from "./analyticsDebugMode.ts";

test("analytics debug mode is available in dev and production runtime", () => {
  assert.equal(isAnalyticsDebugAvailable({ isDev: true }), true);
  assert.equal(isAnalyticsDebugAvailable({ isDev: false }), true);
  assert.equal(isAnalyticsDebugAvailable(), true);
});
