import { useEffect, useMemo } from "react";
import {
  createAgentStatusController,
  type AgentStatusController
} from "@tutti-os/agent-gui";
import { createDesktopAgentStatusSource } from "../services/createDesktopAgentStatusSource.ts";

type DesktopAgentStatusControllerInput = Parameters<
  typeof createDesktopAgentStatusSource
>[0];

/** Owns the Desktop host adapter/controller lifetime for one workspace scope. */
export function useDesktopAgentStatusController(
  input: DesktopAgentStatusControllerInput
): AgentStatusController {
  const controller = useMemo(
    () =>
      createAgentStatusController({
        source: createDesktopAgentStatusSource(input)
      }),
    [
      input.agentActivityRuntime,
      input.agents,
      input.workspaceAgentProbes,
      input.workspaceId
    ]
  );
  useEffect(() => () => controller.close(), [controller]);
  return controller;
}
