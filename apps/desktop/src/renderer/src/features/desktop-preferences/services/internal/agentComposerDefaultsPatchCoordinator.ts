import {
  desktopAgentComposerDefaultsFields,
  type DesktopAgentComposerDefaultsPatch
} from "../../../../../../shared/preferences/index.ts";
import type {
  DesktopAgentComposerDefaultsField,
  DesktopAgentComposerDefaultsPatchResult
} from "../desktopPreferencesService.interface.ts";

type AgentComposerDefaultsField = DesktopAgentComposerDefaultsField;

interface VersionedPatchValue {
  revision: number;
  value: string | null;
}

interface PatchWaiter {
  reject: (error: Error) => void;
  requestedRevisions: Partial<Record<AgentComposerDefaultsField, number>>;
  resolve: (result: DesktopAgentComposerDefaultsPatchResult) => void;
}

interface TargetPatchState {
  acknowledgedRevisions: Partial<
    Record<AgentComposerDefaultsField, Set<number>>
  >;
  attemptCount: number;
  correlationId: string;
  cycleRevision: number;
  desired: Partial<Record<AgentComposerDefaultsField, VersionedPatchValue>>;
  firstAttemptStartedAt: number;
  inFlight: boolean;
  latestRevisionByField: Partial<Record<AgentComposerDefaultsField, number>>;
  nextRevision: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  waiters: Set<PatchWaiter>;
}

export interface AgentComposerDefaultsPatchFailureDetails {
  agentTargetId: string;
  attemptCount: number;
  changedFields: AgentComposerDefaultsField[];
  correlationId: string;
  durationMs: number;
  errorCode: string;
  errorMessage: string;
}

export class AgentComposerDefaultsPatchFailure extends Error {
  readonly details: AgentComposerDefaultsPatchFailureDetails;

  constructor(details: AgentComposerDefaultsPatchFailureDetails) {
    super(details.errorMessage);
    this.name = "AgentComposerDefaultsPatchFailure";
    this.details = details;
  }
}

export interface AgentComposerDefaultsPatchCoordinatorDependencies {
  createCorrelationId?: () => string;
  now?: () => number;
  publish: (input: {
    agentTargetId: string;
    clientMutationId: string;
    patch: DesktopAgentComposerDefaultsPatch;
  }) => Promise<void>;
  retryDelaysMs?: readonly [number, number];
}

export class AgentComposerDefaultsPatchCoordinator {
  private readonly dependencies: Required<
    Pick<
      AgentComposerDefaultsPatchCoordinatorDependencies,
      "createCorrelationId" | "now" | "retryDelaysMs"
    >
  > &
    Pick<AgentComposerDefaultsPatchCoordinatorDependencies, "publish">;
  private readonly states = new Map<string, TargetPatchState>();
  private disposed = false;

  constructor(dependencies: AgentComposerDefaultsPatchCoordinatorDependencies) {
    this.dependencies = {
      createCorrelationId:
        dependencies.createCorrelationId ?? (() => crypto.randomUUID()),
      now: dependencies.now ?? (() => Date.now()),
      publish: dependencies.publish,
      retryDelaysMs: dependencies.retryDelaysMs ?? [1_000, 3_000]
    };
  }

  patch(
    rawAgentTargetId: string,
    rawPatch: DesktopAgentComposerDefaultsPatch | null
  ): Promise<DesktopAgentComposerDefaultsPatchResult> {
    if (this.disposed) {
      return Promise.resolve(emptyPatchResult());
    }
    const agentTargetId = rawAgentTargetId.trim();
    const patch = normalizePatch(rawPatch);
    if (!agentTargetId || Object.keys(patch).length === 0) {
      return Promise.resolve(emptyPatchResult());
    }

    const state = this.stateFor(agentTargetId);
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.attemptCount = 0;
    state.correlationId = this.dependencies.createCorrelationId();
    state.cycleRevision += 1;
    state.firstAttemptStartedAt = this.dependencies.now();

    const requestedRevisions: PatchWaiter["requestedRevisions"] = {};
    for (const field of desktopAgentComposerDefaultsFields) {
      if (!(field in patch)) {
        continue;
      }
      const revision = ++state.nextRevision;
      state.desired[field] = { revision, value: patch[field] ?? null };
      state.latestRevisionByField[field] = revision;
      requestedRevisions[field] = revision;
    }

    const promise = new Promise<DesktopAgentComposerDefaultsPatchResult>(
      (resolve, reject) => {
        state.waiters.add({ reject, requestedRevisions, resolve });
      }
    );
    this.resolveSatisfiedWaiters(state);
    if (!state.inFlight) {
      void this.runAttempt(agentTargetId, state);
    }
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.states.values()) {
      if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer);
      }
      for (const waiter of state.waiters) {
        waiter.resolve({
          acknowledgedFields: [],
          supersededFields: requestedFields(waiter.requestedRevisions)
        });
      }
      state.waiters.clear();
    }
    this.states.clear();
  }

  private stateFor(agentTargetId: string): TargetPatchState {
    const existing = this.states.get(agentTargetId);
    if (existing) {
      return existing;
    }
    const created: TargetPatchState = {
      acknowledgedRevisions: {},
      attemptCount: 0,
      correlationId: this.dependencies.createCorrelationId(),
      cycleRevision: 0,
      desired: {},
      firstAttemptStartedAt: 0,
      inFlight: false,
      latestRevisionByField: {},
      nextRevision: 0,
      retryTimer: null,
      waiters: new Set()
    };
    this.states.set(agentTargetId, created);
    return created;
  }

  private async runAttempt(
    agentTargetId: string,
    state: TargetPatchState
  ): Promise<void> {
    if (this.disposed || state.inFlight) {
      return;
    }
    const snapshot = snapshotDesiredPatch(state.desired);
    if (snapshot.fields.length === 0) {
      this.resolveSatisfiedWaiters(state);
      this.deleteStateIfIdle(agentTargetId, state);
      return;
    }

    state.inFlight = true;
    state.attemptCount += 1;
    const attemptCount = state.attemptCount;
    const correlationId = state.correlationId;
    const cycleRevision = state.cycleRevision;
    try {
      await this.dependencies.publish({
        agentTargetId,
        clientMutationId: correlationId,
        patch: snapshot.patch
      });
      for (const field of snapshot.fields) {
        const revision = snapshot.revisions[field]!;
        (state.acknowledgedRevisions[field] ??= new Set()).add(revision);
        if (state.desired[field]?.revision === revision) {
          delete state.desired[field];
        }
      }
      state.attemptCount = 0;
      this.resolveSatisfiedWaiters(state);
    } catch (error) {
      if (state.cycleRevision === cycleRevision && attemptCount >= 3) {
        const failure = createPatchFailure({
          agentTargetId,
          attemptCount,
          changedFields: snapshot.fields,
          correlationId,
          durationMs: Math.max(
            0,
            this.dependencies.now() - state.firstAttemptStartedAt
          ),
          error
        });
        for (const field of snapshot.fields) {
          if (state.desired[field]?.revision === snapshot.revisions[field]) {
            delete state.desired[field];
          }
        }
        for (const waiter of state.waiters) {
          waiter.reject(failure);
        }
        state.waiters.clear();
      }
    } finally {
      state.inFlight = false;
    }

    if (this.disposed) {
      return;
    }
    if (Object.keys(state.desired).length === 0) {
      this.deleteStateIfIdle(agentTargetId, state);
      return;
    }
    if (state.cycleRevision !== cycleRevision) {
      void this.runAttempt(agentTargetId, state);
      return;
    }
    if (attemptCount < 3) {
      const retryDelay = this.dependencies.retryDelaysMs[attemptCount - 1];
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        void this.runAttempt(agentTargetId, state);
      }, retryDelay);
    }
  }

  private resolveSatisfiedWaiters(state: TargetPatchState): void {
    for (const waiter of state.waiters) {
      const acknowledgedFields: AgentComposerDefaultsField[] = [];
      const supersededFields: AgentComposerDefaultsField[] = [];
      let pending = false;
      for (const field of desktopAgentComposerDefaultsFields) {
        const requestedRevision = waiter.requestedRevisions[field];
        if (requestedRevision === undefined) {
          continue;
        }
        if ((state.latestRevisionByField[field] ?? 0) > requestedRevision) {
          supersededFields.push(field);
        } else if (state.acknowledgedRevisions[field]?.has(requestedRevision)) {
          acknowledgedFields.push(field);
        } else {
          pending = true;
        }
      }
      if (!pending) {
        state.waiters.delete(waiter);
        waiter.resolve({ acknowledgedFields, supersededFields });
      }
    }
  }

  private deleteStateIfIdle(
    agentTargetId: string,
    state: TargetPatchState
  ): void {
    if (!state.inFlight && state.waiters.size === 0) {
      this.states.delete(agentTargetId);
    }
  }
}

function emptyPatchResult(): DesktopAgentComposerDefaultsPatchResult {
  return { acknowledgedFields: [], supersededFields: [] };
}

function requestedFields(
  revisions: PatchWaiter["requestedRevisions"]
): AgentComposerDefaultsField[] {
  return desktopAgentComposerDefaultsFields.filter(
    (field) => revisions[field] !== undefined
  );
}

function normalizePatch(
  input: DesktopAgentComposerDefaultsPatch | null
): DesktopAgentComposerDefaultsPatch {
  if (input === null) {
    return {
      model: null,
      permissionModeId: null,
      reasoningEffort: null,
      speed: null
    };
  }
  const result: DesktopAgentComposerDefaultsPatch = {};
  for (const field of desktopAgentComposerDefaultsFields) {
    if (!(field in input)) {
      continue;
    }
    const value = input[field];
    result[field] = typeof value === "string" ? value.trim() || null : null;
  }
  return result;
}

function snapshotDesiredPatch(desired: TargetPatchState["desired"]): {
  fields: AgentComposerDefaultsField[];
  patch: DesktopAgentComposerDefaultsPatch;
  revisions: Partial<Record<AgentComposerDefaultsField, number>>;
} {
  const fields: AgentComposerDefaultsField[] = [];
  const patch: DesktopAgentComposerDefaultsPatch = {};
  const revisions: Partial<Record<AgentComposerDefaultsField, number>> = {};
  for (const field of desktopAgentComposerDefaultsFields) {
    const entry = desired[field];
    if (!entry) {
      continue;
    }
    fields.push(field);
    patch[field] = entry.value;
    revisions[field] = entry.revision;
  }
  return { fields, patch, revisions };
}

function createPatchFailure(input: {
  agentTargetId: string;
  attemptCount: number;
  changedFields: AgentComposerDefaultsField[];
  correlationId: string;
  durationMs: number;
  error: unknown;
}): AgentComposerDefaultsPatchFailure {
  const errorMessage =
    input.error instanceof Error ? input.error.message : String(input.error);
  const errorCode =
    typeof input.error === "object" &&
    input.error !== null &&
    "code" in input.error &&
    typeof input.error.code === "string"
      ? input.error.code
      : "unknown";
  return new AgentComposerDefaultsPatchFailure({
    agentTargetId: input.agentTargetId,
    attemptCount: input.attemptCount,
    changedFields: input.changedFields,
    correlationId: input.correlationId,
    durationMs: input.durationMs,
    errorCode,
    errorMessage
  });
}
