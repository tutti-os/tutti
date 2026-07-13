import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";

export function emitUsageUpdated(
  emit: ClaudeSDKSidecarEventEmitter,
  turnId: string,
  payload: Record<string, unknown>
): void {
  const cleaned: Record<string, unknown> = { turnId };
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) {
      cleaned[key] = value;
    }
  }
  if (Object.keys(cleaned).length <= 1) {
    return;
  }
  emit({ type: "usage_updated", payload: cleaned });
}
