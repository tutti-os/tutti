export interface AgentTranscriptVirtualMeasurements {
  turnHeightsByKey: Readonly<Record<string, number>>;
}

const MAX_RETAINED_SESSION_STATES = 50;
const stateBySessionId = new Map<string, AgentTranscriptVirtualMeasurements>();

export function readAgentTranscriptVirtualMeasurements(
  agentSessionId: string
): AgentTranscriptVirtualMeasurements | null {
  return stateBySessionId.get(agentSessionId) ?? null;
}

export function writeAgentTranscriptVirtualMeasurements(
  agentSessionId: string,
  state: AgentTranscriptVirtualMeasurements
): void {
  stateBySessionId.delete(agentSessionId);
  stateBySessionId.set(agentSessionId, state);
  while (stateBySessionId.size > MAX_RETAINED_SESSION_STATES) {
    const oldestSessionId = stateBySessionId.keys().next().value;
    if (oldestSessionId === undefined) {
      break;
    }
    stateBySessionId.delete(oldestSessionId);
  }
}

export function clearAgentTranscriptVirtualMeasurementsForTest(): void {
  stateBySessionId.clear();
}
