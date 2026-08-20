import {
  claudeAuthRefreshDiagnosticsEnabled,
  claudeCredentialSnapshot,
  debugClaudeAuthRefreshLog
} from "./authDiagnostics.ts";
import {
  logClaudeUnresolvedProviderTurns,
  scheduleClaudeProviderTurnIdentityWarning
} from "./providerTurnDiagnostics.ts";
import type { ProviderTurnPhase } from "./providerTurnAcceptance.ts";
import type { RuntimeTurn } from "./turnLifecycle.ts";

export class ClaudeSessionDiagnostics {
  private readonly cwd: string;
  private readonly providerSessionId: () => string;
  private readonly turns: () => readonly RuntimeTurn[];
  private readonly phaseForTurn: (
    turnId: string
  ) => ProviderTurnPhase | undefined;

  constructor(options: {
    cwd: string;
    providerSessionId: () => string;
    turns: () => readonly RuntimeTurn[];
    phaseForTurn: (turnId: string) => ProviderTurnPhase | undefined;
  }) {
    this.cwd = options.cwd;
    this.providerSessionId = options.providerSessionId;
    this.turns = options.turns;
    this.phaseForTurn = options.phaseForTurn;
  }

  logAuthRefresh(stage: string, payload: Record<string, unknown>): void {
    if (!claudeAuthRefreshDiagnosticsEnabled()) {
      return;
    }
    debugClaudeAuthRefreshLog(stage, {
      providerSessionId: this.providerSessionId(),
      cwd: this.cwd,
      credentials: claudeCredentialSnapshot(),
      ...payload
    });
  }

  scheduleProviderTurnIdentityWarning(
    turn: RuntimeTurn,
    generationId: number
  ): void {
    scheduleClaudeProviderTurnIdentityWarning({
      providerSessionId: this.providerSessionId,
      generationId,
      turn,
      phaseForTurn: this.phaseForTurn
    });
  }

  logQueryFailure(generationId: number, error: unknown): void {
    this.logUnresolvedProviderTurns(
      "query_consumption_failed_before_identity",
      generationId,
      error
    );
  }

  logQueryEnd(generationId: number): void {
    this.logUnresolvedProviderTurns(
      "query_ended_before_identity",
      generationId
    );
  }

  private logUnresolvedProviderTurns(
    stage: string,
    generationId: number,
    error?: unknown
  ): void {
    logClaudeUnresolvedProviderTurns(stage, {
      providerSessionId: this.providerSessionId(),
      generationId,
      turns: this.turns(),
      phaseForTurn: this.phaseForTurn,
      ...(error !== undefined ? { error } : {})
    });
  }
}
