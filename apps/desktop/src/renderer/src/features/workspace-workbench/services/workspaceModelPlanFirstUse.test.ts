import assert from "node:assert/strict";
import test from "node:test";
import { compatibleWorkspaceModelPlanFirstUseTargets } from "./workspaceModelPlanFirstUse.ts";

test("first-use targets keep only enabled protocol-compatible Agents", () => {
  assert.deepEqual(
    compatibleWorkspaceModelPlanFirstUseTargets({
      plan: { protocol: "openai" },
      targets: [
        { enabled: true, id: "codex", name: "Codex", provider: "codex" },
        {
          enabled: true,
          id: "claude",
          name: "Claude Code",
          provider: "claude-code"
        },
        {
          enabled: false,
          id: "disabled-codex",
          name: "Disabled Codex",
          provider: "codex"
        }
      ]
    }).map((target) => target.id),
    ["codex"]
  );
});
