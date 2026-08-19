import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowReleaseNotesAction } from "./appUpdateStatusPresentation.ts";

test("release notes are available for stable download and install actions", () => {
  assert.equal(shouldShowReleaseNotesAction("stable", "download"), true);
  assert.equal(shouldShowReleaseNotesAction("stable", "install"), true);
  assert.equal(shouldShowReleaseNotesAction("stable", "retry"), false);
});

test("release notes are hidden for RC and missing update states", () => {
  assert.equal(shouldShowReleaseNotesAction("rc", "download"), false);
  assert.equal(shouldShowReleaseNotesAction("rc", "install"), false);
  assert.equal(shouldShowReleaseNotesAction(null, "download"), false);
});
