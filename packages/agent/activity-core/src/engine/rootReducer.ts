import {
  createInitialEngineRuntimeState,
  engineRuntimeReducer
} from "./engineRuntime.reducer.ts";
import {
  canPromoteQueuedPrompt,
  createInitialPromptQueueState,
  promptQueueReducer
} from "./promptQueue.reducer.ts";
import { canCancelQueuedSubmit } from "./promptQueue.lookup.ts";
import {
  createInitialPendingIntentsState,
  pendingIntentsReducer
} from "./pendingIntents.reducer.ts";
import {
  createInitialSessionLifecycleState,
  sessionLifecycleReducer
} from "./sessionLifecycle.reducer.ts";
import {
  createInitialSessionReconcileState,
  sessionReconcileReducer
} from "./sessionReconcile.reducer.ts";
import type {
  AgentSessionEngineState,
  EngineIntent,
  EngineReducerResult
} from "./types.ts";

// Root reducer: static composition of domain reducers, zero business logic.
// Cross-domain read-only context is passed explicitly; domains still own all
// decisions and state transitions in their own reducer.

export function createInitialAgentSessionEngineState(): AgentSessionEngineState {
  return {
    engineRuntime: createInitialEngineRuntimeState(),
    pendingIntents: createInitialPendingIntentsState(),
    promptQueue: createInitialPromptQueueState(),
    sessionReconcile: createInitialSessionReconcileState(),
    sessionLifecycle: createInitialSessionLifecycleState()
  };
}

export function rootEngineReducer(
  state: AgentSessionEngineState,
  intent: EngineIntent
): EngineReducerResult<AgentSessionEngineState> {
  const engineRuntime = engineRuntimeReducer(state.engineRuntime, intent);
  const promptQueue = promptQueueReducer(state.promptQueue, intent, {
    deletedSessionIds: state.sessionLifecycle.deletedSessionIds
  });
  const sessionLifecycle = sessionLifecycleReducer(
    state.sessionLifecycle,
    intent,
    {
      queuePromotionAccepted:
        intent.type === "queue/promoted" &&
        canPromoteQueuedPrompt(
          state.promptQueue,
          intent.agentSessionId,
          intent.promptId
        )
    }
  );
  const pendingIntents = pendingIntentsReducer(state.pendingIntents, intent, {
    deletedSessionIds: state.sessionLifecycle.deletedSessionIds,
    sessionLifecycleRecords: sessionLifecycle.state.recordsBySessionId,
    submitCancellationAccepted:
      intent.type === "submit/canceled" &&
      canCancelQueuedSubmit(
        state.promptQueue,
        intent.agentSessionId,
        intent.clientSubmitId
      )
  });
  const sessionReconcile = sessionReconcileReducer(
    state.sessionReconcile,
    intent,
    { deletedSessionIds: state.sessionLifecycle.deletedSessionIds }
  );
  const unchanged =
    engineRuntime.state === state.engineRuntime &&
    pendingIntents.state === state.pendingIntents &&
    promptQueue.state === state.promptQueue &&
    sessionReconcile.state === state.sessionReconcile &&
    sessionLifecycle.state === state.sessionLifecycle;
  const nextState = unchanged
    ? state
    : {
        engineRuntime: engineRuntime.state,
        pendingIntents: pendingIntents.state,
        promptQueue: promptQueue.state,
        sessionReconcile: sessionReconcile.state,
        sessionLifecycle: sessionLifecycle.state
      };
  return {
    commands: [
      ...engineRuntime.commands,
      ...pendingIntents.commands,
      ...promptQueue.commands,
      ...sessionReconcile.commands,
      ...sessionLifecycle.commands
    ],
    state: nextState
  };
}
