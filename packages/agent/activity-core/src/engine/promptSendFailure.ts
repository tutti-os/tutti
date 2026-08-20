import type { EngineIntent } from "./types.ts";

export function isPreTurnSendFailure(intent: EngineIntent): boolean {
  if (
    intent.type !== "engine/commandResult" ||
    intent.commandType !== "queue/sendPrompt" ||
    intent.outcome !== "failed"
  ) {
    return false;
  }
  const errorReason = intent.errorReason?.trim();
  const errorCode = intent.errorCode?.trim();
  return (
    errorReason === "agent.no_active_turn" ||
    errorCode === "agent.no_active_turn" ||
    errorReason === "agent.session_no_active_turn" ||
    errorCode === "agent.session_no_active_turn" ||
    errorReason === "agent.process_cleanup_pending" ||
    errorCode === "agent.process_cleanup_pending"
  );
}
