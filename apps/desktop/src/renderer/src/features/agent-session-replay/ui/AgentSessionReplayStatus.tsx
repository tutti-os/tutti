import { useEffect, useRef, useState } from "react";
import type { DesktopRuntimeApi } from "@preload/types";
import type { DesktopAgentSessionReplayStatus } from "@shared/contracts/ipc";
import { useTranslation } from "@renderer/i18n";
import { Toast } from "@renderer/lib/toast";
import { replayActionErrorMessage } from "./replayActionErrorMessage.ts";

const replayStatusPollIntervalMs = 250;

export function AgentSessionReplayStatus({
  runtimeApi
}: {
  runtimeApi: Pick<DesktopRuntimeApi, "getAgentSessionReplayStatus">;
}): null {
  const { t } = useTranslation();
  const [status, setStatus] = useState<DesktopAgentSessionReplayStatus | null>(
    null
  );
  const notifiedPhaseRef =
    useRef<DesktopAgentSessionReplayStatus["phase"]>(undefined);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const next = await runtimeApi.getAgentSessionReplayStatus();
        if (disposed) return;
        setStatus((current) =>
          areReplayStatusesEqual(current, next) ? current : next
        );
        if (
          next.active &&
          next.phase !== "complete" &&
          next.phase !== "failed"
        ) {
          timer = window.setTimeout(poll, replayStatusPollIntervalMs);
        }
      } catch {
        if (!disposed) setStatus(null);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runtimeApi]);

  useEffect(() => {
    if (!status?.phase || notifiedPhaseRef.current === status.phase) return;
    notifiedPhaseRef.current = status.phase;
    if (status.phase === "complete") {
      Toast.Success(
        t("workspace.agentGui.sessionReplay.replay.validationComplete")
      );
    } else if (status.phase === "failed") {
      Toast.Error(
        t("workspace.agentGui.sessionReplay.replay.validationFailed"),
        status.errorMessage
          ? replayActionErrorMessage(status.errorMessage, (table) =>
              t("workspace.agentGui.sessionReplay.replay.stateMismatch", {
                table
              })
            )
          : undefined
      );
    }
  }, [status, t]);

  return null;
}

function areReplayStatusesEqual(
  current: DesktopAgentSessionReplayStatus | null,
  next: DesktopAgentSessionReplayStatus
): boolean {
  return (
    current !== null &&
    current.active === next.active &&
    current.currentCheckpoint === next.currentCheckpoint &&
    current.errorMessage === next.errorMessage &&
    current.paused === next.paused &&
    current.phase === next.phase &&
    current.targetCheckpoint === next.targetCheckpoint &&
    current.timingMode === next.timingMode &&
    current.totalCheckpoints === next.totalCheckpoints
  );
}
