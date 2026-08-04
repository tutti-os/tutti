import type { AgentSessionActivityReplayDriver } from "./agentSessionActivityReplayDriver.ts";
import type { AgentSessionReplayWorkspaceBridge as AgentSessionReplayWorkspaceBridgeContract } from "@tutti-os/agent-session-replay";
import type {
  AgentSessionReplayNodeLaunchRequest,
  AgentSessionReplayWorkspaceCoordinator,
  AgentSessionReplayWorkspaceCassette,
  AgentSessionReplayWorkspaceSnapshot
} from "./agentSessionReplayWorkspaceCoordinator.ts";

export type AgentSessionReplayWorkspaceBridge =
  AgentSessionReplayWorkspaceBridgeContract<
    AgentSessionReplayWorkspaceCassette,
    AgentSessionReplayWorkspaceSnapshot
  >;

interface ReplayWorkspaceGlobal {
  __tuttiAgentSessionReplayDriver?: AgentSessionActivityReplayDriver;
  __tuttiAgentSessionReplayWorkspace?: AgentSessionReplayWorkspaceBridge;
}

export function installAgentSessionReplayWorkspaceBridge(input: {
  arrangeNodes(nodeIds: readonly string[]): void;
  coordinator: AgentSessionReplayWorkspaceCoordinator;
  launchNode(
    request: AgentSessionReplayNodeLaunchRequest
  ): Promise<string | null>;
}): {
  bridge: AgentSessionReplayWorkspaceBridge;
  coordinator: AgentSessionReplayWorkspaceCoordinator;
  dispose(): void;
} {
  const coordinator = input.coordinator;
  const replayGlobal = globalThis as typeof globalThis & ReplayWorkspaceGlobal;
  let disposed = false;
  let registrationDriver: AgentSessionActivityReplayDriver | null = null;
  const registeredCassetteIds = new Set<string>();
  const bridge: AgentSessionReplayWorkspaceBridge = {
    async activate(cassetteId) {
      if (disposed) throw new Error("Replay Workspace bridge was disposed");
      await coordinator.activateCassette(cassetteId, input.launchNode);
      return coordinator.getSnapshot();
    },
    async bootstrap(cassettes) {
      if (disposed) throw new Error("Replay Workspace bridge was disposed");
      const driver = replayGlobal.__tuttiAgentSessionReplayDriver;
      if (!driver) {
        throw new Error("Replay activity driver is not ready");
      }
      const pendingCassetteIds: string[] = [];
      try {
        for (const cassette of cassettes) {
          driver.registerCassette({
            agentSessionIds: [cassette.rootAgentSessionId],
            cassetteId: cassette.cassetteId
          });
          pendingCassetteIds.push(cassette.cassetteId);
        }
        const bindings = await coordinator.bootstrap(
          cassettes,
          input.launchNode
        );
        if (bindings.length > 0) {
          const nodeIds = bindings.map((binding) => binding.nodeId);
          try {
            input.arrangeNodes(nodeIds);
          } catch {}
        }
        for (const cassetteId of pendingCassetteIds) {
          registeredCassetteIds.add(cassetteId);
        }
        registrationDriver = driver;
        return coordinator.getSnapshot();
      } catch (error) {
        for (const cassetteId of pendingCassetteIds) {
          driver.removeCassette(cassetteId);
        }
        coordinator.reset();
        throw error;
      }
    },
    observedSession(agentSessionId) {
      const binding = coordinator.getCassetteForSession(agentSessionId);
      return binding?.detailHydrated
        ? {
            messageVersion: binding.canonicalMessageVersion,
            updatedAtUnixMs: binding.canonicalSessionUpdatedAtUnixMs
          }
        : null;
    },
    snapshot: coordinator.getSnapshot
  };
  replayGlobal.__tuttiAgentSessionReplayWorkspace = bridge;
  return {
    bridge,
    coordinator,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (registrationDriver) {
        for (const cassetteId of registeredCassetteIds) {
          registrationDriver.removeCassette(cassetteId);
        }
      }
      registeredCassetteIds.clear();
      registrationDriver = null;
      coordinator.reset();
      if (replayGlobal.__tuttiAgentSessionReplayWorkspace === bridge) {
        delete replayGlobal.__tuttiAgentSessionReplayWorkspace;
      }
    }
  };
}
