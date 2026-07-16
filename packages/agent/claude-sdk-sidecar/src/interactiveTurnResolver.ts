import type { ToolPermissionOptions } from "./interactive.ts";
import { stringValue } from "./runtimeValues.ts";
import type { ToolActivityProjector } from "./toolActivity.ts";
import type { TurnLifecycle } from "./turnLifecycle.ts";

export function resolveInteractiveTurnId(
  callbackOptions: ToolPermissionOptions,
  turns: TurnLifecycle,
  activities: ToolActivityProjector
): string {
  const toolUseID = stringValue(callbackOptions.toolUseID);
  if (toolUseID) {
    const delegatedTurnId = activities.resolveInteractiveTurnId(toolUseID);
    if (delegatedTurnId) {
      return delegatedTurnId;
    }
  }
  if (turns.awaitingContinuation) {
    const runningDelegatedTurnId = activities.runningDelegatedTurnId();
    if (runningDelegatedTurnId) {
      return runningDelegatedTurnId;
    }
    const latestDelegatedTurnId = activities.latestDelegatedTurnId();
    if (latestDelegatedTurnId) {
      return latestDelegatedTurnId;
    }
  }
  if (turns.activeId) {
    return turns.activeId;
  }
  for (let index = turns.queue.length - 1; index >= 0; index -= 1) {
    const turn = turns.queue[index];
    if (turn && !turn.settled && !turn.synthetic) {
      return turn.turnId;
    }
  }
  const runningDelegatedTurnId = activities.runningDelegatedTurnId();
  if (runningDelegatedTurnId) {
    return runningDelegatedTurnId;
  }
  for (let index = turns.queue.length - 1; index >= 0; index -= 1) {
    const turn = turns.queue[index];
    if (turn && !turn.settled) {
      return turn.turnId;
    }
  }
  return activities.latestDelegatedTurnId();
}
