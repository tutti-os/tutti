import type { DesktopAgentSessionReplayPhase } from "@shared/contracts/ipc";

export function resolveAgentSessionReplayControlAvailability(input: {
  currentCheckpoint: number;
  lastCheckpoint: number;
  phase: DesktopAgentSessionReplayPhase | undefined;
  updating: boolean;
}): {
  canNext: boolean;
  canPause: boolean;
  canPrevious: boolean;
  canReplace: boolean;
  canSetSpeed: boolean;
} {
  const replaying = input.phase === "replaying";
  const canReplace =
    !input.updating &&
    (replaying || input.phase === "complete" || input.phase === "failed");
  return {
    canNext:
      !input.updating &&
      replaying &&
      input.currentCheckpoint < input.lastCheckpoint,
    canPause: !input.updating && replaying,
    canPrevious: canReplace && input.currentCheckpoint > 0,
    canReplace,
    canSetSpeed: !input.updating && replaying
  };
}
