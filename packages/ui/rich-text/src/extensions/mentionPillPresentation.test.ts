import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveMentionPillIconUrl,
  resolveMentionPillKind
} from "./mentionPillPresentation.ts";

test("resolves mention pill kinds from provider identity", () => {
  assert.equal(resolveMentionPillKind("workspace-app", undefined), "app");
  assert.equal(resolveMentionPillKind("agent-session", undefined), "session");
  assert.equal(
    resolveMentionPillKind("workspace-reference", { source: "task" }),
    "issue"
  );
  assert.equal(
    resolveMentionPillKind("workspace-reference", { source: "app" }),
    "app"
  );
});

test("prefers hydrated presentation icons over legacy scope icons", () => {
  assert.equal(
    resolveMentionPillIconUrl({
      presentation: { iconUrl: " app://weather.png " },
      scope: { icon: "app://legacy.png" }
    }),
    "app://weather.png"
  );
  assert.equal(
    resolveMentionPillIconUrl({ scope: { icon: " app://legacy.png " } }),
    "app://legacy.png"
  );
});
