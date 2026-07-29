import { useAgentConversationNowUnixMs } from "./AgentConversationClock";

export function useElapsedSeconds(startUnixMs: number | null): number | null {
  const nowUnixMs = useAgentConversationNowUnixMs(startUnixMs !== null);
  if (startUnixMs === null) {
    return null;
  }
  return Math.max(
    0,
    Math.floor(((nowUnixMs ?? startUnixMs) - startUnixMs) / 1_000)
  );
}
