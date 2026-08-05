import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentGUIProps } from "@tutti-os/agent-gui";
import type {
  AgentCLIUpdateNoticeSnapshot,
  IAgentCLIUpdateNoticeService
} from "../services/agentCLIUpdateNoticeService.interface.ts";

const EMPTY_SNAPSHOT: AgentCLIUpdateNoticeSnapshot = { notices: [] };
const subscribeNoop = (): (() => void) => () => {};

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
  const getTargetSnapshot = useCallback(
    () =>
      eligible ? service.getSnapshotForTarget(agentTargetId) : EMPTY_SNAPSHOT,
    [agentTargetId, eligible, service]
  );
  const snapshot = useSyncExternalStore(
    eligible ? service.subscribe : subscribeNoop,
    getTargetSnapshot,
    getTargetSnapshot
  );

  useEffect(() => {
    service.setSurfaceEligible(surfaceId, eligible, agentTargetId);
    return () => service.releaseSurface(surfaceId);
  }, [agentTargetId, eligible, service, surfaceId]);

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

  return {
    notices: snapshot.notices,
    onAction
  };
}
