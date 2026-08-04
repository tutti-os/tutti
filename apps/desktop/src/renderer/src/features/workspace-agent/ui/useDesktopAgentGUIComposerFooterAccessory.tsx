import type { AgentGUIProps } from "@tutti-os/agent-gui";
import { lazy, Suspense, useCallback } from "react";
import type { DesktopAgentGUIWorkbenchBodyProps } from "./desktopAgentGUIWorkbenchModel.ts";

type ComposerFooterAccessory = NonNullable<
  AgentGUIProps["renderSlots"]["composerFooterAccessory"]
>;

const AgentSessionReplayComposerFooterAccessory = lazy(() =>
  import("../../agent-session-replay/ui/AgentSessionReplayComposerFooterAccessory.tsx").then(
    (module) => ({ default: module.AgentSessionReplayComposerFooterAccessory })
  )
);

export function useDesktopAgentGUIComposerFooterAccessory(input: {
  agentSessionReplayService: DesktopAgentGUIWorkbenchBodyProps["agentSessionReplayService"];
  nodeId: string;
  runtimeApi: DesktopAgentGUIWorkbenchBodyProps["runtimeApi"];
  sessionRecordingEnabled: boolean;
  workspaceId: string;
}): ComposerFooterAccessory {
  const runtimeApi = input.runtimeApi;
  const replayRuntimeActive =
    runtimeApi?.isAgentSessionReplayRuntime?.() === true;
  const replayUiEnabled = replayRuntimeActive || input.sessionRecordingEnabled;
  return useCallback(
    (composer) =>
      !runtimeApi || !replayUiEnabled ? null : (
        <Suspense fallback={null}>
          <AgentSessionReplayComposerFooterAccessory
            composer={composer}
            agentSessionReplayService={input.agentSessionReplayService}
            nodeId={input.nodeId}
            replayRuntimeActive={replayRuntimeActive}
            runtimeApi={runtimeApi}
            sessionRecordingEnabled={input.sessionRecordingEnabled}
            workspaceId={input.workspaceId}
          />
        </Suspense>
      ),
    [
      input.agentSessionReplayService,
      input.nodeId,
      input.sessionRecordingEnabled,
      input.workspaceId,
      replayRuntimeActive,
      replayUiEnabled,
      runtimeApi
    ]
  );
}
