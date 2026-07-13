export function canonicalTurnKey(
  agentSessionId: string,
  turnId: string
): string {
  return scopedEntityKey(agentSessionId, turnId);
}

export function canonicalInteractionKey(
  agentSessionId: string,
  turnId: string,
  requestId: string
): string {
  return scopedEntityKey(agentSessionId, scopedEntityKey(turnId, requestId));
}

function scopedEntityKey(agentSessionId: string, entityId: string): string {
  const session = agentSessionId.trim();
  const entity = entityId.trim();
  return `${session.length}:${session}${entity}`;
}
