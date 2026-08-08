export interface AgentSessionReplayCanonicalObservation {
  messageVersion: number;
  updatedAtUnixMs: number;
}

/**
 * Per-Cassette Agent Node readiness signals. Tutti reports these from each
 * bound Agent Node; TSH may report the same shape so runners can wait without
 * polling `main[data-agent-session-id]` as the sole authority.
 */
export interface AgentSessionReplayCassetteNodeStatus {
  detailHydrated: boolean;
  mounted: boolean;
  nodeId: string | null;
  selectedAgentSessionId: string | null;
}

export type AgentSessionReplayCassetteNodeStatusPatch =
  Partial<AgentSessionReplayCassetteNodeStatus>;

export interface AgentSessionReplayWorkspaceBridge<
  TCassette,
  TSnapshot,
  TObservation = AgentSessionReplayCanonicalObservation | null
> {
  activate(cassetteId: string): Promise<TSnapshot>;
  bootstrap(cassettes: readonly TCassette[]): Promise<TSnapshot>;
  observedSession(agentSessionId: string): TObservation;
  /**
   * Optional product-side readiness reporter. When implemented, reported fields
   * take precedence over DOM probes for the matching Cassette.
   */
  reportCassetteNodeStatus?(
    cassetteId: string,
    status: AgentSessionReplayCassetteNodeStatusPatch
  ): void;
  snapshot(): TSnapshot;
}
