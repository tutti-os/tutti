export interface AgentSessionReplayCanonicalObservation {
  messageVersion: number;
  updatedAtUnixMs: number;
}

export interface AgentSessionReplayWorkspaceBridge<
  TCassette,
  TSnapshot,
  TObservation = AgentSessionReplayCanonicalObservation | null
> {
  activate(cassetteId: string): Promise<TSnapshot>;
  bootstrap(cassettes: readonly TCassette[]): Promise<TSnapshot>;
  observedSession(agentSessionId: string): TObservation;
  snapshot(): TSnapshot;
}
