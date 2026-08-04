import { useEffect, useMemo } from "react";
import type {
  AgentSessionEngine,
  EngineExternalCommand,
  EngineIntent
} from "@tutti-os/agent-activity-core";
import { installAgentSessionActivityReplayDriver } from "./activity-replay-driver.ts";

interface AgentSessionActivityReplaySource {
  addSessionEngineActivityObserver(
    workspaceId: string,
    observer: {
      observeCommand(command: EngineExternalCommand): void;
      observeIntent(intent: EngineIntent): void;
    }
  ): () => void;
  getSessionEngine(workspaceId: string): AgentSessionEngine;
}

export function WorkspaceAgentSessionActivityReplayBinding({
  activitySource,
  workspaceId
}: {
  activitySource: AgentSessionActivityReplaySource;
  workspaceId: string;
}): React.JSX.Element {
  const engine = useMemo(
    () => activitySource.getSessionEngine(workspaceId),
    [activitySource, workspaceId]
  );
  return (
    <AgentSessionActivityReplayBinding
      addObserver={(observer) =>
        activitySource.addSessionEngineActivityObserver(workspaceId, observer)
      }
      engine={engine}
    />
  );
}

export function AgentSessionActivityReplayBinding({
  addObserver,
  engine
}: {
  addObserver(observer: {
    observeCommand(command: EngineExternalCommand): void;
    observeIntent(intent: EngineIntent): void;
  }): () => void;
  engine: AgentSessionEngine;
}): null {
  useEffect(() => {
    const driver = installAgentSessionActivityReplayDriver({ engine });
    const removeObserver = addObserver({
      observeCommand(command) {
        if (!driver.hasRegisteredCassettes()) return;
        driver.observeCommand(command);
      },
      observeIntent(intent) {
        if (!driver.hasRegisteredCassettes()) return;
        driver.observeIntent(intent);
      }
    });

    return () => {
      removeObserver();
      driver.dispose();
    };
  }, [addObserver, engine]);

  return null;
}
