export type AgentSessionActivityEventKind = "effect" | "intent";

/**
 * Provider-neutral Agent Session Replay activity event.
 *
 * Product adapters own persistence and scope mapping. `scopeId` is the
 * product's replay scope identity (for example a Tutti workspace or a TSH
 * Room); it is not interpreted by this package.
 */
export interface AgentSessionActivityEvent {
  agentSessionId?: string;
  causedByEventId?: string;
  correlationId?: string;
  eventId: string;
  kind: AgentSessionActivityEventKind;
  occurredAtUnixMs: number;
  payload: Readonly<Record<string, unknown>>;
  schemaVersion: number;
  scopeId: string;
  sequence: number;
  type: string;
}
