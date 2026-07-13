import assert from "node:assert/strict";
import test from "node:test";
import { shouldMinimizeOwnerAfterAgentWindowOpen } from "./hostWindowPolicy.ts";

test("agent pop-out minimizes only the legacy Workspace owner", () => {
  assert.equal(shouldMinimizeOwnerAfterAgentWindowOpen(false), true);
  assert.equal(shouldMinimizeOwnerAfterAgentWindowOpen(true), false);
});
