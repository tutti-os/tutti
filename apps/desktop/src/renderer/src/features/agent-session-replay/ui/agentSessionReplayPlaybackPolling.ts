import type {
  DesktopAgentSessionReplayPlayback,
  DesktopAgentSessionReplayStatus
} from "@shared/contracts/ipc";

export interface AgentSessionReplayPlaybackSnapshot {
  playback: DesktopAgentSessionReplayPlayback;
  status: DesktopAgentSessionReplayStatus;
}

export function shouldPollAgentSessionReplayPlayback(
  playback: DesktopAgentSessionReplayPlayback,
  status: DesktopAgentSessionReplayStatus
): boolean {
  return (
    status.active &&
    (status.phase === "replaying" || status.phase === "verifying")
  );
}

export function areAgentSessionReplayPlaybackSnapshotsEqual(
  current: AgentSessionReplayPlaybackSnapshot | null,
  next: AgentSessionReplayPlaybackSnapshot
): boolean {
  return (
    current !== null &&
    current.playback.active === next.playback.active &&
    current.playback.paused === next.playback.paused &&
    current.playback.speed === next.playback.speed &&
    current.playback.timingMode === next.playback.timingMode &&
    current.status.active === next.status.active &&
    current.status.cassetteId === next.status.cassetteId &&
    JSON.stringify(current.status.cassettes) ===
      JSON.stringify(next.status.cassettes) &&
    current.status.currentCheckpoint === next.status.currentCheckpoint &&
    current.status.errorMessage === next.status.errorMessage &&
    current.status.paused === next.status.paused &&
    current.status.phase === next.status.phase &&
    current.status.targetCheckpoint === next.status.targetCheckpoint &&
    current.status.timingMode === next.status.timingMode &&
    current.status.totalCheckpoints === next.status.totalCheckpoints
  );
}
