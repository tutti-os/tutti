import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGUIAgent } from "@tutti-os/agent-gui";
import { AgentGuiAgentsLoader } from "./agentGuiAgentsLoader.ts";

test("workspace workbench retries the agent directory after a transient load failure", async () => {
  const agents: readonly AgentGUIAgent[] = [
    {
      agentTargetId: "local:codex",
      availability: { status: "ready" },
      iconUrl: "tutti-asset://agent/codex.png",
      name: "Codex",
      provider: "codex"
    }
  ];
  let attempts = 0;
  const loader = new AgentGuiAgentsLoader(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("temporary failure");
    }
    return agents;
  });

  await assert.rejects(loader.load(), /temporary failure/);
  assert.deepEqual(await loader.load(), agents);
  assert.equal(attempts, 2);
});

test("workspace workbench caches a successfully loaded empty agent directory", async () => {
  let attempts = 0;
  const loader = new AgentGuiAgentsLoader(async () => {
    attempts += 1;
    return [];
  });

  assert.deepEqual(await loader.load(), []);
  assert.deepEqual(await loader.load(), []);
  assert.equal(attempts, 1);
});
