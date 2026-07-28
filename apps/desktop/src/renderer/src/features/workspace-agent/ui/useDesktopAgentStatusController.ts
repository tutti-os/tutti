import { useEffect, useMemo } from "react";
import {
  createAgentStatusController,
  type AgentStatusController,
  type AgentStatusSource
} from "@tutti-os/agent-gui";
import { createDesktopAgentStatusSource } from "../services/createDesktopAgentStatusSource.ts";

type DesktopAgentStatusControllerInput = Parameters<
  typeof createDesktopAgentStatusSource
>[0];

/** Owns the Desktop host adapter/controller lifetime for one workspace scope. */
export function useDesktopAgentStatusController(
  input: DesktopAgentStatusControllerInput,
  workspaceSource?: AgentStatusSource
): AgentStatusController {
  const source = useMemo(
    () => workspaceSource ?? createDesktopAgentStatusSource(input),
    [
      input.agentActivityRuntime,
      input.agents,
      input.workspaceAgentProbes,
      input.workspaceId,
      workspaceSource
    ]
  );
  const controller = useMemo(
    () => createAgentStatusController({ source }),
    [source]
  );
  useEffect(() => () => controller.close(), [controller]);
  return controller;
}
