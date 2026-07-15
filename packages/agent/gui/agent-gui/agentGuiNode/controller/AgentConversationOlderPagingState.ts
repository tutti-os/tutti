export type OlderMessagePagingPhase = "in_flight" | "exhausted" | "failed";

export interface OlderMessagePagingRequest {
  agentSessionId: string;
  beforeVersion: number;
  requestId: number;
}

export interface OlderMessagePagingEntry extends OlderMessagePagingRequest {
  phase: OlderMessagePagingPhase;
}

export type BeginOlderMessagePagingResult =
  | { kind: "started"; request: OlderMessagePagingRequest }
  | { kind: "suppressed"; entry: OlderMessagePagingEntry };

export class AgentConversationOlderPagingState {
  private readonly entries = new Map<string, OlderMessagePagingEntry>();
  private nextRequestId = 0;

  begin(
    agentSessionId: string,
    beforeVersion: number
  ): BeginOlderMessagePagingResult {
    const current = this.entries.get(agentSessionId);
    if (
      current?.phase === "in_flight" ||
      current?.phase === "exhausted" ||
      current?.beforeVersion === beforeVersion
    ) {
      return { kind: "suppressed", entry: current };
    }
    const request = {
      agentSessionId,
      beforeVersion,
      requestId: ++this.nextRequestId
    };
    this.entries.set(agentSessionId, { ...request, phase: "in_flight" });
    return { kind: "started", request };
  }

  abandon(request: OlderMessagePagingRequest): boolean {
    if (!this.isCurrent(request)) return false;
    this.entries.delete(request.agentSessionId);
    return true;
  }

  fail(request: OlderMessagePagingRequest): boolean {
    if (!this.isCurrent(request)) return false;
    this.entries.set(request.agentSessionId, { ...request, phase: "failed" });
    return true;
  }

  resolve(request: OlderMessagePagingRequest, exhausted: boolean): boolean {
    if (!this.isCurrent(request)) return false;
    if (exhausted) {
      this.entries.set(request.agentSessionId, {
        ...request,
        phase: "exhausted"
      });
    } else {
      this.entries.delete(request.agentSessionId);
    }
    return true;
  }

  reset(agentSessionId: string): void {
    this.entries.delete(agentSessionId);
  }

  private isCurrent(request: OlderMessagePagingRequest): boolean {
    const current = this.entries.get(request.agentSessionId);
    return (
      current?.phase === "in_flight" &&
      current.beforeVersion === request.beforeVersion &&
      current.requestId === request.requestId
    );
  }
}
