import assert from "node:assert/strict";
import test from "node:test";
import { shouldReportPredefinePageview } from "./predefinePageviewAnalyticsOwnership.ts";

test("predefine pageview ownership defaults to enabled for legacy and web routes", () => {
  assert.equal(shouldReportPredefinePageview("?view=workspace"), true);
});

test("predefine pageview ownership enables only the primary window marker", () => {
  assert.equal(
    shouldReportPredefinePageview(
      "?view=agent&reportPredefinePageview=1&workspaceId=workspace-1"
    ),
    true
  );
  assert.equal(
    shouldReportPredefinePageview(
      "?view=agent&reportPredefinePageview=0&workspaceId=workspace-1"
    ),
    false
  );
});
