import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultAgentUnifiedIconUrl,
  resolveWorkspaceDockIconSet
} from "./workspaceDockIconStyle.ts";

test("default workspace dock agent icons use renderer-loadable assets", () => {
  const icons = resolveWorkspaceDockIconSet({
    appearance: "light",
    style: "default"
  });

  assert.match(icons.agents.codex!, /codex\.png$/);
  assert.match(icons.agents["claude-code"]!, /claudecode\.png$/);
  assert.match(icons.agentUnified, /agent-unified\.png$/);
  assert.doesNotMatch(icons.agents.codex!, /^tutti-asset:/);
  assert.doesNotMatch(icons.agents["claude-code"]!, /^tutti-asset:/);
  assert.doesNotMatch(icons.agentUnified, /^tutti-asset:/);
  assert.match(icons.document, /document\.png$/);
});

test("default unified Agent icon is reusable as a provider-neutral fallback", () => {
  assert.match(defaultAgentUnifiedIconUrl, /agent-unified\.png$/);
  assert.doesNotMatch(defaultAgentUnifiedIconUrl, /^tutti-asset:/);
});
