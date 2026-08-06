import type { AgentGUIProps } from "@tutti-os/agent-gui";
import type { DesktopRuntimeApi } from "@preload/types";
import { createAgentSessionReplayLauncher } from "../services/agentSessionReplayLauncher.ts";
import type { AgentSessionReplayService } from "../services/agentSessionReplayService.ts";
import { AgentSessionReplayComposerAccessory } from "./AgentSessionReplayComposerAccessory.tsx";
import { AgentSessionReplayNodeRuntime } from "./AgentSessionReplayNodeRuntime.tsx";

type ComposerContext = Parameters<
  NonNullable<AgentGUIProps["renderSlots"]["composerFooterAccessory"]>
>[0];

type ReplayRuntimeApi = Pick<
  DesktopRuntimeApi,
  | "getAgentSessionReplayPlayback"
  | "getAgentSessionReplayStatus"
  | "isAgentSessionReplayRuntime"
  | "launchAgentSessionReplay"
  | "logTerminalDiagnostic"
  | "revealAgentSessionReplayCassette"
  | "sendAgentSessionReplayControl"
  | "setAgentSessionReplayPlayback"
  | "waitForAgentSessionReplay"
>;

export function AgentSessionReplayComposerFooterAccessory({
  agentSessionReplayService,
  composer,
  nodeId,
  replayRuntimeActive,
  runtimeApi,
  sessionRecordingEnabled,
  workspaceId
}: {
  agentSessionReplayService: AgentSessionReplayService | null;
  composer: ComposerContext;
  nodeId: string;
  replayRuntimeActive: boolean;
  runtimeApi: ReplayRuntimeApi;
  sessionRecordingEnabled: boolean;
  workspaceId: string;
}): React.JSX.Element {
  const launcher =
    sessionRecordingEnabled && agentSessionReplayService
      ? createAgentSessionReplayLauncher({
          runtimeApi,
          service: agentSessionReplayService
        })
      : undefined;

  return (
    <>
      {replayRuntimeActive ? (
        <AgentSessionReplayNodeRuntime
          nodeId={nodeId}
          runtimeApi={runtimeApi}
        />
      ) : null}
      {sessionRecordingEnabled && agentSessionReplayService ? (
        <AgentSessionReplayComposerAccessory
          composer={composer}
          launcher={launcher}
          revealCassette={(cassetteId) =>
            runtimeApi.revealAgentSessionReplayCassette({
              cassetteId,
              workspaceId
            })
          }
          service={agentSessionReplayService}
        />
      ) : null}
    </>
  );
}
