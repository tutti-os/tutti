import {
  AGENT_SESSION_ENGINE_LOCAL_ORIGIN,
  createAgentSessionEngine,
  type AgentSessionEngine,
  type EngineCommandPort
} from "@tutti-os/agent-activity-core";

export function createTestAgentSessionEngine(
  workspaceId = "test-workspace",
  commandPort: EngineCommandPort = {
    execute: async () => ({ ok: true })
  }
): AgentSessionEngine {
  const engine = createAgentSessionEngine({
    clock: { nowUnixMs: () => Date.now() },
    commandPort,
    identity: { origin: AGENT_SESSION_ENGINE_LOCAL_ORIGIN, workspaceId },
    scheduler: {
      schedule(delayMs, task) {
        // timing: temp code, commit first
        const timer = setTimeout(task, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }
    }
  });
  engine.dispatch({ type: "workspace/reconcileRequested", workspaceId });
  return engine;
}
