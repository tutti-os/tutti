import type { EngineDiagnosticSink } from "./diagnostics.ts";
import { createEngineEffectExecutor } from "./effectExecutor.ts";
import { createEngineExpiryClock } from "./expiryClock.ts";
import {
  createInitialAgentSessionEngineState,
  rootEngineReducer
} from "./rootReducer.ts";
import {
  isEngineInternalCommand,
  type AgentSessionEngine,
  type AgentSessionEngineIdentity,
  type AgentSessionEngineListener,
  type AgentSessionEngineState,
  type EngineClock,
  type EngineCommandPort,
  type EngineDispatchOptions,
  type EngineIntent,
  type EngineScheduledTask,
  type EngineScheduler
} from "./types.ts";

// Session engine factory (docs/architecture/agent-gui-refactor-plan.md,
// sections 3.3 and 4.1, engine skeleton slice).
//
// All state lives inside this closure: one instance per workspace + origin
// pair, injected explicitly by the host. The dispatch loop is serial — an
// intent dispatched while a drain is running is queued and reduced within the
// same drain — and subscribers are notified at most once per drain cycle.

/**
 * Frame window for coalescing high-frequency intents (streaming message
 * updates). Migrated from the desktop activity service's 33ms event batching;
 * the engine owns this timing once event wiring moves over in later slices.
 */
export const ENGINE_INTENT_BATCH_DELAY_MS = 33;

export interface CreateAgentSessionEngineInput {
  batchDelayMs?: number;
  clock: EngineClock;
  commandPort: EngineCommandPort;
  diagnosticSink?: EngineDiagnosticSink;
  identity: AgentSessionEngineIdentity;
  scheduler: EngineScheduler;
}

export function createAgentSessionEngine({
  batchDelayMs = ENGINE_INTENT_BATCH_DELAY_MS,
  clock,
  commandPort,
  diagnosticSink,
  identity,
  scheduler
}: CreateAgentSessionEngineInput): AgentSessionEngine {
  if (identity.workspaceId.trim().length === 0) {
    throw new Error("agent session engine requires a non-empty workspaceId");
  }
  if (identity.origin.trim().length === 0) {
    throw new Error("agent session engine requires a non-empty origin");
  }
  const engineIdentity: AgentSessionEngineIdentity = Object.freeze({
    origin: identity.origin,
    workspaceId: identity.workspaceId
  });

  let state: AgentSessionEngineState = createInitialAgentSessionEngineState();
  const listeners = new Set<AgentSessionEngineListener>();
  const intentQueue: EngineIntent[] = [];
  const batchedIntents: EngineIntent[] = [];
  let batchFlushTask: EngineScheduledTask | null = null;
  let draining = false;
  let disposed = false;

  const expiryClock = createEngineExpiryClock({
    clock,
    onExpired: (intent) => {
      dispatch(intent);
    },
    scheduler
  });

  const effectExecutor = createEngineEffectExecutor({
    commandPort,
    onResult: (intent) => {
      dispatch(intent);
    },
    scheduler,
    ...(diagnosticSink === undefined ? {} : { diagnosticSink })
  });

  function notifyListeners(): void {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch (error) {
        if (diagnosticSink) {
          diagnosticSink({ error, type: "listenerError" });
        } else {
          console.error(
            "[agent-session-engine-diagnostic]",
            JSON.stringify({
              event: "listener_error",
              error: error instanceof Error ? error.message : String(error),
              origin: engineIdentity.origin,
              workspaceId: engineIdentity.workspaceId
            })
          );
        }
      }
    }
  }

  function drainQueue(): void {
    if (draining || disposed) {
      return;
    }
    draining = true;
    const stateBeforeDrain = state;
    try {
      for (
        let intent = intentQueue.shift();
        intent !== undefined;
        intent = intentQueue.shift()
      ) {
        const result = rootEngineReducer(state, intent);
        state = result.state;
        for (const command of result.commands) {
          if (isEngineInternalCommand(command)) {
            expiryClock.apply(command);
          } else {
            effectExecutor.execute(command);
          }
        }
      }
    } finally {
      draining = false;
    }
    if (state !== stateBeforeDrain) {
      notifyListeners();
    }
  }

  function flushBatchedIntents(): void {
    if (batchFlushTask !== null) {
      batchFlushTask.cancel();
      batchFlushTask = null;
    }
    if (batchedIntents.length === 0) {
      return;
    }
    intentQueue.push(...batchedIntents);
    batchedIntents.length = 0;
  }

  function dispatch(
    intent: EngineIntent,
    options?: EngineDispatchOptions
  ): void {
    if (disposed) {
      diagnosticSink?.({
        intentType: intent.type,
        type: "intentDroppedAfterDispose"
      });
      return;
    }
    const scopedIntent = intentForEngineIdentity(intent, engineIdentity);
    if (!scopedIntent) {
      diagnosticSink?.({
        intentType: intent.type,
        type: "intentDroppedForIdentityMismatch"
      });
      return;
    }
    if (options?.batch === true) {
      batchedIntents.push(scopedIntent);
      if (batchFlushTask === null) {
        batchFlushTask = scheduler.schedule(batchDelayMs, () => {
          batchFlushTask = null;
          flushBatchedIntents();
          drainQueue();
        });
      }
      return;
    }
    // Non-batched dispatch flushes the pending frame first so cross-intent
    // ordering is preserved (a terminal event never overtakes the streaming
    // updates that preceded it).
    flushBatchedIntents();
    intentQueue.push(scopedIntent);
    drainQueue();
  }

  return {
    identity: engineIdentity,
    dispatch,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (batchFlushTask !== null) {
        batchFlushTask.cancel();
        batchFlushTask = null;
      }
      batchedIntents.length = 0;
      intentQueue.length = 0;
      expiryClock.dispose();
      effectExecutor.dispose();
      listeners.clear();
    },
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function intentForEngineIdentity(
  intent: EngineIntent,
  identity: AgentSessionEngineIdentity
): EngineIntent | null {
  if ("workspaceId" in intent && intent.workspaceId !== undefined) {
    if (intent.workspaceId.trim() !== identity.workspaceId) {
      return null;
    }
  }
  if (intent.type === "session/upserted") {
    return intent.session.workspaceId === identity.workspaceId ? intent : null;
  }
  if (intent.type === "session/snapshotReceived") {
    const sessions = intent.sessions.filter(
      (session) => session.workspaceId === identity.workspaceId
    );
    return sessions.length === intent.sessions.length
      ? intent
      : { ...intent, sessions };
  }
  return intent;
}
