import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentGUIProps } from "@tutti-os/agent-gui";
import type { IAgentCLIUpdateNoticeService } from "../services/agentCLIUpdateNoticeService.interface.ts";
import { projectDesktopAgentCLIUpdateNoticesForTarget } from "../services/internal/desktopAgentCLIUpdateNoticeModel.ts";

const EMPTY_NOTICES = [] as const;

export function useDesktopAgentCLIUpdateNotices({
  agentTargetId,
  eligible,
  service,
  surfaceId
}: {
  agentTargetId: string | null;
  eligible: boolean;
  service: IAgentCLIUpdateNoticeService;
  surfaceId: string;
}): {
  notices: AgentGUIProps["hostCapabilities"]["agentProviderUpdateNotices"];
  onAction: NonNullable<
    AgentGUIProps["hostActions"]["onAgentProviderUpdateNoticeAction"]
  >;
} {
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot
  );

  useEffect(() => {
    service.setSurfaceEligible(surfaceId, eligible);
    return () => service.releaseSurface(surfaceId);
  }, [eligible, service, surfaceId]);

  const onAction = useCallback<
    NonNullable<
      AgentGUIProps["hostActions"]["onAgentProviderUpdateNoticeAction"]
    >
  >(
    (input) => {
      void service.runAction(input);
    },
    [service]
  );

  const notices = useMemo(
    () =>
      eligible
        ? projectDesktopAgentCLIUpdateNoticesForTarget(
            snapshot.notices,
            agentTargetId
          )
        : EMPTY_NOTICES,
    [agentTargetId, eligible, snapshot.notices]
  );

  return {
    notices,
    onAction
  };
}
