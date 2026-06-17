import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceAppIconResolver } from "./workspaceAppIconStyle.ts";

test("default workspace app icon resolver includes built-in agent launcher apps", () => {
  const resolveIconUrl = createDefaultWorkspaceAppIconResolver();

  assert.match(resolveIconUrl("agent-codex") ?? "", /\/codex\.png$/u);
  assert.match(
    resolveIconUrl("agent-claude-code") ?? "",
    /\/claudecode\.png$/u
  );
  assert.equal(resolveIconUrl("automation"), null);
  assert.equal(resolveIconUrl("ai-media-canvas"), null);
  assert.equal(resolveIconUrl("daily-tech-radar"), null);
  assert.equal(resolveIconUrl("group-chat"), null);
  assert.equal(resolveIconUrl("vibe-design"), null);
  assert.equal(resolveIconUrl("missing-app"), null);
});
