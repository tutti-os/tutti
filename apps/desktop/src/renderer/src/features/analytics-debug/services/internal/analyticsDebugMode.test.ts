import assert from "node:assert/strict";
import test from "node:test";
import { isAnalyticsDebugAvailable } from "./analyticsDebugMode.ts";

test("analytics debug is available only in development builds", () => {
  assert.equal(isAnalyticsDebugAvailable({ isDev: true }), true);
  assert.equal(isAnalyticsDebugAvailable({ isDev: false }), false);
  assert.equal(isAnalyticsDebugAvailable(), false);
});
