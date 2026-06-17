import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceDockIconSet } from "./workspaceDockIconStyle.ts";

test("default workspace dock agent icons use the desktop asset protocol", () => {
  const icons = resolveWorkspaceDockIconSet({
    appearance: "light",
    style: "default"
  });

  assert.equal(icons.agents.codex, "tutti-asset://agent/codex.png");
  assert.equal(
    icons.agents["claude-code"],
    "tutti-asset://agent/claudecode.png"
  );
  assert.match(icons.document, /document\.png$/);
});
