import {
  ClaudeTurnBindingResolutionError,
  type ClaudeTurnBinding,
  type ClaudeTurnBindingResolver
} from "./sessionFork.ts";
import {
  logClaudeProviderTurnDiagnostic,
  providerTurnDiagnosticError
} from "./providerTurnDiagnostics.ts";

export type ProviderTurnPhase =
  | "queued"
  | "dispatched"
  | "provider_observed"
  | "resolving_identity"
  | "identity_resolved"
  | "streaming"
  | "waiting_approval"
  | "waiting_input"
  | "running_tool"
  | "terminal";

export type ProviderTurnIdentityBindingDisposition =
  | "bound"
  | "already_bound"
  | "conflict"
  | "missing";

type ProviderTurnAcceptanceTriggerPhase = Extract<
  ProviderTurnPhase,
  "streaming" | "waiting_approval" | "waiting_input" | "running_tool"
>;

export type ProviderTurnAcceptanceTarget = {
  turnId: string;
  promptCorrelationId: string;
  providerTurnId: string;
};

type ActiveAcceptance = {
  readonly turnId: string;
  readonly controller: AbortController;
  readonly promise: Promise<void>;
};

const DEFAULT_RESOLUTION_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const MAX_RETRY_DELAY_MS = 250;

export class ProviderTurnAcceptanceCoordinator {
  private readonly cwd: string;
  private readonly getProviderSessionId: () => string;
  private readonly resolveTarget: () =>
    | ProviderTurnAcceptanceTarget
    | undefined;
  private readonly resolveBinding: ClaudeTurnBindingResolver;
  private readonly bindIdentity: (
    turnId: string,
    providerTurnId: string
  ) => ProviderTurnIdentityBindingDisposition;
  private readonly emitCheckpoint: (
    turnId: string,
    binding: ClaudeTurnBinding
  ) => void;
  private readonly resolutionTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  private readonly wait: (
    delayMs: number,
    signal: AbortSignal
  ) => Promise<void>;
  private readonly phases = new Map<string, ProviderTurnPhase>();
  private active: ActiveAcceptance | undefined;

  constructor(options: {
    cwd: string;
    getProviderSessionId: () => string;
    resolveTarget: () => ProviderTurnAcceptanceTarget | undefined;
    resolveBinding: ClaudeTurnBindingResolver;
    bindIdentity: (
      turnId: string,
      providerTurnId: string
    ) => ProviderTurnIdentityBindingDisposition;
    emitCheckpoint: (turnId: string, binding: ClaudeTurnBinding) => void;
    resolutionTimeoutMs?: number;
    retryDelayMs?: number;
    now?: () => number;
    wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  }) {
    this.cwd = options.cwd;
    this.getProviderSessionId = options.getProviderSessionId;
    this.resolveTarget = options.resolveTarget;
    this.resolveBinding = options.resolveBinding;
    this.bindIdentity = options.bindIdentity;
    this.emitCheckpoint = options.emitCheckpoint;
    this.resolutionTimeoutMs =
      options.resolutionTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? abortableDelay;
  }

  markQueued(turnId: string): void {
    this.setPhase(turnId, "queued");
  }

  markDispatched(turnId: string): void {
    this.setPhase(turnId, "dispatched");
  }

  phase(turnId: string): ProviderTurnPhase | undefined {
    return this.phases.get(turnId.trim());
  }

  async ensure(
    nextPhase: ProviderTurnAcceptanceTriggerPhase,
    signal?: AbortSignal
  ): Promise<void> {
    const target = this.resolveTarget();
    if (!target || !target.turnId.trim()) {
      return;
    }
    if (target.providerTurnId.trim()) {
      this.setPhase(target.turnId, nextPhase);
      return;
    }
    this.setPhase(target.turnId, "provider_observed");
    const active = this.active;
    if (active?.turnId === target.turnId) {
      await raceWithAbort(active.promise, signal);
      this.setPhase(target.turnId, nextPhase);
      return;
    }
    if (active) {
      active.controller.abort();
    }
    const controller = new AbortController();
    const promise = this.resolveAndBind(
      target,
      nextPhase,
      controller.signal
    ).finally(() => {
      if (this.active?.promise === promise) {
        this.active = undefined;
      }
    });
    this.active = { turnId: target.turnId, controller, promise };
    await raceWithAbort(promise, signal);
    this.setPhase(target.turnId, nextPhase);
  }

  cancel(turnId = ""): void {
    const normalizedTurnId = turnId.trim();
    if (
      this.active &&
      (!normalizedTurnId || this.active.turnId === normalizedTurnId)
    ) {
      this.active.controller.abort();
    }
  }

  terminal(turnId: string): void {
    const normalizedTurnId = turnId.trim();
    this.cancel(normalizedTurnId);
    this.setPhase(normalizedTurnId, "terminal");
    while (this.phases.size > 64) {
      const oldest = this.phases.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.phases.delete(oldest);
    }
  }

  private async resolveAndBind(
    target: ProviderTurnAcceptanceTarget,
    triggerPhase: ProviderTurnAcceptanceTriggerPhase,
    signal: AbortSignal
  ): Promise<void> {
    const startedAtMs = this.now();
    const providerSessionId = this.getProviderSessionId().trim();
    const recoveryToken = target.promptCorrelationId.trim();
    const basePayload = {
      turnId: target.turnId,
      providerSessionId,
      promptCorrelationId: recoveryToken,
      triggerPhase,
      timeoutMs: this.resolutionTimeoutMs
    };
    if (!providerSessionId || !recoveryToken) {
      logClaudeProviderTurnDiagnostic("identity_recovery_failed", {
        ...basePayload,
        attempts: 0,
        elapsedMs: 0,
        reason: "missing_required_identity",
        hasProviderSessionId: Boolean(providerSessionId),
        hasPromptCorrelationId: Boolean(recoveryToken)
      });
      throw new Error(
        "Claude provider turn identity resolution requires session and correlation identities"
      );
    }
    const deadline = this.now() + Math.max(0, this.resolutionTimeoutMs);
    let retryDelayMs = Math.max(1, this.retryDelayMs);
    let attempts = 0;
    let lastAbsent: ClaudeTurnBindingResolutionError | undefined;
    this.setPhase(target.turnId, "resolving_identity");
    logClaudeProviderTurnDiagnostic("identity_recovery_started", basePayload);
    for (;;) {
      try {
        throwIfAborted(signal);
        attempts += 1;
        const binding = await raceWithAbort(
          this.resolveBinding({
            sessionId: providerSessionId,
            cwd: this.cwd,
            recoveryToken
          }),
          signal
        );
        this.acceptBinding(target.turnId, providerSessionId, binding);
        this.setPhase(target.turnId, "identity_resolved");
        logClaudeProviderTurnDiagnostic("identity_recovery_resolved", {
          ...basePayload,
          attempts,
          elapsedMs: Math.max(0, this.now() - startedAtMs),
          providerTurnId: binding.providerTurnId.trim(),
          providerCheckpointMessageId:
            binding.providerCheckpointMessageId.trim(),
          correlationIdRewritten:
            binding.providerTurnId.trim() !== recoveryToken
        });
        return;
      } catch (error) {
        if (signal.aborted) {
          logClaudeProviderTurnDiagnostic("identity_recovery_failed", {
            ...basePayload,
            attempts,
            elapsedMs: Math.max(0, this.now() - startedAtMs),
            reason: "canceled",
            ...resolutionDetails(lastAbsent),
            error: providerTurnDiagnosticError(error)
          });
          throw abortError();
        }
        if (
          !(error instanceof ClaudeTurnBindingResolutionError) ||
          error.reason !== "absent"
        ) {
          logClaudeProviderTurnDiagnostic("identity_recovery_failed", {
            ...basePayload,
            attempts,
            elapsedMs: Math.max(0, this.now() - startedAtMs),
            reason: identityRecoveryFailureReason(error),
            ...resolutionDetails(error),
            error: providerTurnDiagnosticError(error)
          });
          throw error;
        }
        lastAbsent = error;
        const remainingMs = deadline - this.now();
        if (remainingMs <= 0) {
          logClaudeProviderTurnDiagnostic("identity_recovery_failed", {
            ...basePayload,
            attempts,
            elapsedMs: Math.max(0, this.now() - startedAtMs),
            reason: "transcript_absent_at_deadline",
            ...resolutionDetails(error),
            error: providerTurnDiagnosticError(error)
          });
          throw new Error(
            "Claude provider turn identity was not persisted before the acceptance deadline",
            { cause: error }
          );
        }
        try {
          await this.wait(Math.min(retryDelayMs, remainingMs), signal);
        } catch (waitError) {
          if (signal.aborted) {
            logClaudeProviderTurnDiagnostic("identity_recovery_failed", {
              ...basePayload,
              attempts,
              elapsedMs: Math.max(0, this.now() - startedAtMs),
              reason: "canceled",
              ...resolutionDetails(lastAbsent),
              error: providerTurnDiagnosticError(waitError)
            });
          }
          throw waitError;
        }
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  private acceptBinding(
    turnId: string,
    expectedProviderSessionId: string,
    binding: ClaudeTurnBinding
  ): void {
    const providerSessionId = binding.providerSessionId.trim();
    const providerTurnId = binding.providerTurnId.trim();
    if (providerSessionId !== expectedProviderSessionId || !providerTurnId) {
      throw new Error(
        "Claude provider turn recovery returned inconsistent identity"
      );
    }
    const disposition = this.bindIdentity(turnId, providerTurnId);
    if (disposition === "conflict" || disposition === "missing") {
      throw new Error(
        "Claude provider turn recovery returned inconsistent identity"
      );
    }
    if (disposition === "bound") {
      this.emitCheckpoint(turnId, binding);
    }
  }

  private setPhase(turnId: string, phase: ProviderTurnPhase): void {
    const normalizedTurnId = turnId.trim();
    if (!normalizedTurnId) {
      return;
    }
    this.phases.set(normalizedTurnId, phase);
  }
}

function identityRecoveryFailureReason(error: unknown): string {
  if (error instanceof ClaudeTurnBindingResolutionError) {
    return `transcript_${error.reason}`;
  }
  return "transcript_read_or_binding_failed";
}

function resolutionDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof ClaudeTurnBindingResolutionError) || !error.details) {
    return {};
  }
  return { ...error.details };
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      Math.max(0, delayMs)
    );
    const abort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}

function abortError(): Error {
  const error = new Error("Provider turn acceptance was canceled");
  error.name = "AbortError";
  return error;
}
