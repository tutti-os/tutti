import type { AgentGUIProps } from "@tutti-os/agent-gui";
import { useCallback, useMemo } from "react";
import { createAgentSessionReplayLauncher } from "../../agent-session-replay/services/agentSessionReplayLauncher.ts";
import { AgentSessionActivityReplayBinding } from "../../agent-session-replay/ui/AgentSessionActivityReplayBinding.tsx";
import { AgentSessionReplayComposerAccessory } from "../../agent-session-replay/ui/AgentSessionReplayComposerAccessory.tsx";
import { AgentSessionReplayPlaybackControls } from "../../agent-session-replay/ui/AgentSessionReplayPlaybackSpeed.tsx";
import { AgentSessionReplayStatus } from "../../agent-session-replay/ui/AgentSessionReplayStatus.tsx";
import type { DesktopAgentGUIWorkbenchBodyProps } from "./desktopAgentGUIWorkbenchModel.ts";

type ComposerFooterAccessory = NonNullable<
  AgentGUIProps["renderSlots"]["composerFooterAccessory"]
>;

export function useDesktopAgentGUIComposerFooterAccessory(input: {
  agentSessionActivityReplay: DesktopAgentGUIWorkbenchBodyProps["agentSessionActivityReplay"];
  agentSessionReplayService: DesktopAgentGUIWorkbenchBodyProps["agentSessionReplayService"];
  runtimeApi: DesktopAgentGUIWorkbenchBodyProps["runtimeApi"];
  sessionRecordingEnabled: boolean;
  workspaceId: string;
}): ComposerFooterAccessory {
  const activityReplayBinding = useMemo(
    () =>
      input.runtimeApi ? (
        <AgentSessionActivityReplayBinding
          addObserver={input.agentSessionActivityReplay.addObserver}
          engine={input.agentSessionActivityReplay.engine}
          runtimeApi={input.runtimeApi}
        />
      ) : null,
    [input.agentSessionActivityReplay, input.runtimeApi]
  );

  return useCallback(
    (composer) => (
      <>
        {activityReplayBinding}
        {input.runtimeApi ? (
          <>
            <AgentSessionReplayStatus runtimeApi={input.runtimeApi} />
            <AgentSessionReplayPlaybackControls runtimeApi={input.runtimeApi} />
          </>
        ) : null}
        {input.sessionRecordingEnabled ? (
          <AgentSessionReplayComposerAccessory
            composer={composer}
            launcher={
              input.runtimeApi
                ? createAgentSessionReplayLauncher({
                    runtimeApi: input.runtimeApi,
                    service: input.agentSessionReplayService,
                    workspaceId: input.workspaceId
                  })
                : undefined
            }
            service={input.agentSessionReplayService}
          />
        ) : null}
      </>
    ),
    [
      activityReplayBinding,
      input.agentSessionReplayService,
      input.runtimeApi,
      input.sessionRecordingEnabled,
      input.workspaceId
    ]
  );
}
