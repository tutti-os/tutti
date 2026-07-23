/**
 * Authoritative coverage for the durable message window currently held by the
 * engine. Message versions are mutable change cursors, so neither the minimum
 * version nor a gap in versions can prove that older messages exist.
 */
export interface AgentActivitySessionMessageWindow {
  hasOlderMessages: boolean;
  oldestLoadedVersion: number | null;
}
