import { useEffect } from "react";
import type {
  AgentSessionEngine,
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import type { DesktopRuntimeApi } from "@preload/types";
import { installAgentSessionActivityReplayDriver } from "../services/agentSessionActivityReplayDriver.ts";

export function AgentSessionActivityReplayBinding({
  addObserver,
  engine,
  runtimeApi
}: {
  addObserver(observer: {
    observeCommand(command: EngineExternalCommand): void;
    observeIntent(intent: EngineIntent): void;
  }): () => void;
  engine: AgentSessionEngine;
  runtimeApi: Pick<
    DesktopRuntimeApi,
    "getAgentSessionReplayStatus" | "logTerminalDiagnostic"
  >;
}): null {
  useEffect(() => {
    let disposed = false;
    let removeObserver: (() => void) | undefined;
    let driver: ReturnType<
      typeof installAgentSessionActivityReplayDriver
    > | null = null;

    void runtimeApi
      .getAgentSessionReplayStatus()
      .then((status) => {
        if (
          disposed ||
          !status.active ||
          (status.phase !== "replaying" && status.phase !== "verifying")
        ) {
          return;
        }
        driver = installAgentSessionActivityReplayDriver({ engine });
        removeObserver = addObserver({
          observeCommand() {},
          observeIntent: driver.observeIntent
        });
      })
      .catch((error: unknown) => {
        void runtimeApi.logTerminalDiagnostic({
          details: {
            error: error instanceof Error ? error.message : String(error)
          },
          event: "agent.session_replay.bridge_initialization_failed",
          level: "error",
          workspaceId: engine.identity.workspaceId
        });
      });

    return () => {
      disposed = true;
      removeObserver?.();
      driver?.dispose();
    };
  }, [addObserver, engine, runtimeApi]);

  return null;
}
