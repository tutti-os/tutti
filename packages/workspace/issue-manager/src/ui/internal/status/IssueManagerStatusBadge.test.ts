import assert from "node:assert/strict";
import test from "node:test";

import { issueManagerStatusBadgeVariant } from "./IssueManagerStatusBadge.ts";

test("issue manager statuses map to semantic badge variants", () => {
  assert.equal(issueManagerStatusBadgeVariant("not_started"), "default");
  assert.equal(issueManagerStatusBadgeVariant("running"), "accent");
  assert.equal(issueManagerStatusBadgeVariant("pending_acceptance"), "pending");
  assert.equal(issueManagerStatusBadgeVariant("completed"), "success");
  assert.equal(issueManagerStatusBadgeVariant("failed"), "destructive");
  assert.equal(issueManagerStatusBadgeVariant("canceled"), "muted");
});
