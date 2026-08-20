import {
  canonicalTurnKey,
  type AgentActivityComposerOptions,
  type AgentSessionEngine,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import {
  agentGUIPerformanceDuration,
  createAgentGUIPerformanceMonitor,
  trackAgentGUIComposerOptionsLoad,
  type AgentGUIComposerOptionsPerformanceEvent
} from "./agentGUIPerformanceMonitor";

describe("createAgentGUIPerformanceMonitor", () => {
  it.each([
    [0, "lt_1s"],
    [999, "lt_1s"],
    [1_000, "1s_to_3s"],
    [3_000, "3s_to_10s"],
    [10_000, "10s_to_30s"],
    [30_000, "30s_to_60s"],
    [60_000, "gte_60s"]
  ] as const)("buckets %d ms as %s", (durationMs, durationBucket) => {
    expect(agentGUIPerformanceDuration(durationMs)).toEqual({
      durationBucket,
      durationMs
    });
  });

  it("reports a Composer options load start before a slow request settles", async () => {
    let nowUnixMs = 1_000;
    const harness = createEngineHarness(engineState({}));
    const onEvent = vi.fn();
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      nowUnixMs: () => nowUnixMs,
      onEvent,
      subscribeSessionEvents: harness.subscribeSessionEvents
    });
    let resolveOptions!: (value: AgentActivityComposerOptions) => void;
    const optionsPromise = new Promise<AgentActivityComposerOptions>(
      (resolve) => {
        resolveOptions = resolve;
      }
    );

    const pending = monitor.trackComposerOptionsLoad({
      agentTargetId: "codex-target",
      cwd: "/workspace/project",
      force: true,
      load: () => optionsPromise,
      provider: "codex",
      source: "runtime"
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTargetId: "codex-target",
        force: true,
        hasDirectory: true,
        provider: "codex",
        source: "runtime",
        startedAtUnixMs: 1_000,
        type: "composer_options_load_started",
        workspaceId: "workspace-1"
      })
    );
    const operationId = onEvent.mock.calls[0]?.[0]?.operationId;
    const options = {
      models: [{ label: "GPT-5", value: "gpt-5" }],
      provider: "codex"
    } as AgentActivityComposerOptions;
    nowUnixMs = 61_000;
    resolveOptions(options);

    await expect(pending).resolves.toBe(options);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        durationBucket: "gte_60s",
        durationMs: 60_000,
        modelCount: 1,
        operationId,
        outcome: "completed",
        source: "runtime",
        type: "composer_options_load_settled"
      })
    );
    monitor.dispose();
  });

  it("reports an engine Composer options failure without exposing its message", async () => {
    let nowUnixMs = 2_000;
    const harness = createEngineHarness(engineState({}));
    const onEvent = vi.fn();
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      nowUnixMs: () => nowUnixMs,
      onEvent,
      subscribeSessionEvents: harness.subscribeSessionEvents
    });
    const failure = new Error("private provider response");
    Object.assign(failure, { code: "composer_options_timeout" });

    const pending = monitor.trackComposerOptionsLoad({
      agentTargetId: "codex-target",
      load: () => Promise.reject(failure),
      provider: "codex",
      source: "session-engine"
    });
    nowUnixMs = 6_000;

    await expect(pending).rejects.toBe(failure);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        durationBucket: "3s_to_10s",
        durationMs: 4_000,
        errorCategory: "composer_options_timeout",
        errorCode: "composer_options_timeout",
        failureStage: "options_load",
        outcome: "failed",
        source: "session-engine",
        type: "composer_options_load_settled"
      })
    );
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(
      "private provider response"
    );
    monitor.dispose();
  });

  it("reports section stages and bounded model names", async () => {
    const onEvent = vi.fn();
    const options = {
      models: [
        { label: "GPT-5", value: "gpt-5" },
        { label: "GPT-5 duplicate", value: "gpt-5" },
        { label: "Other", value: "model\nwith-control" }
      ],
      provider: "codex"
    } as AgentActivityComposerOptions;

    await expect(
      trackAgentGUIComposerOptionsLoad({
        agentTargetId: "codex-target",
        cwd: "/private/workspace",
        load: () => Promise.resolve(options),
        onEvent,
        provider: "codex",
        section: "core",
        source: "runtime",
        stage: "model_catalog",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe(options);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        section: "core",
        stage: "model_catalog",
        type: "composer_options_stage_started"
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelNames: ["gpt-5", "modelwith-control"],
        section: "core",
        stage: "model_catalog",
        type: "composer_options_stage_settled"
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelNames: ["gpt-5", "modelwith-control"],
        type: "composer_options_load_settled"
      })
    );
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain(
      "/private/workspace"
    );
  });

  it("uses bounded unknown for a missing Composer error code and rethrows it", async () => {
    const sinkFailure = new Error("event sink failed");
    const failure = new Error("private provider response");
    const onEvent = vi.fn<
      (event: AgentGUIComposerOptionsPerformanceEvent) => void
    >(() => {
      throw sinkFailure;
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const pending = trackAgentGUIComposerOptionsLoad({
        agentTargetId: "codex-target",
        load: () => Promise.reject(failure),
        onEvent,
        provider: "codex",
        source: "runtime",
        workspaceId: "workspace-1"
      });

      await expect(pending).rejects.toBe(failure);
      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(onEvent.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          errorCategory: "unknown",
          errorCode: "unknown",
          failureStage: "options_load",
          outcome: "failed",
          type: "composer_options_load_settled"
        })
      );
      expect(JSON.stringify(onEvent.mock.calls)).not.toContain(
        "private provider response"
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not report expected Composer options cancellation as a failure", async () => {
    const harness = createEngineHarness(engineState({}));
    const onEvent = vi.fn();
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      onEvent,
      subscribeSessionEvents: harness.subscribeSessionEvents
    });

    const pending = monitor.trackComposerOptionsLoad({
      agentTargetId: "codex-target",
      load: () => Promise.reject(new Error("composer_options_load_superseded")),
      provider: "codex",
      source: "session-engine"
    });

    await expect(pending).rejects.toThrow("composer_options_load_superseded");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "composer_options_load_started" })
    );
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        type: "composer_options_load_settled"
      })
    );
    monitor.dispose();
  });

  it("does not let a Composer options event sink change the load result", async () => {
    const eventSinkFailure = new Error("event sink failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const options = {
      models: [],
      provider: "codex"
    } as unknown as AgentActivityComposerOptions;

    try {
      await expect(
        trackAgentGUIComposerOptionsLoad({
          agentTargetId: "codex-target",
          load: () => Promise.resolve(options),
          onEvent: () => {
            throw eventSinkFailure;
          },
          provider: "codex",
          source: "runtime",
          workspaceId: "workspace-1"
        })
      ).resolves.toBe(options);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("reports an exact early queued first-token duration after exact Turn binding", () => {
    let nowUnixMs = 1_000;
    const harness = createEngineHarness(
      engineState({
        submits: {
          "submit-1": pendingSubmit({ status: "requested", turnId: null })
        }
      })
    );
    const onEvent = vi.fn();
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      nowUnixMs: () => nowUnixMs,
      onEvent,
      subscribeSessionEvents: harness.subscribeSessionEvents
    });

    nowUnixMs = 2_000;
    harness.emitSessionEvent(messageDelta({ turnId: "stale-turn" }));
    nowUnixMs = 61_500;
    const firstToken = messageDelta({ kind: "reasoning", turnId: "turn-1" });
    harness.emitSessionEvent(firstToken);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "prompt_first_token_received" })
    );

    harness.setState(
      engineState({
        submits: {
          "submit-1": pendingSubmit({ status: "accepted", turnId: "turn-1" })
        }
      })
    );
    harness.emitSessionEvent(firstToken);

    expect(onEvent).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      durationBucket: "gte_60s",
      durationMs: 60_500,
      firstTokenKind: "reasoning",
      observedAtUnixMs: 61_500,
      operationId: "submit-1",
      provider: "codex",
      queued: true,
      source: "submit",
      startedAtUnixMs: 1_000,
      turnId: "turn-1",
      type: "prompt_first_token_received",
      workspaceId: "workspace-1"
    });
    expect(
      onEvent.mock.calls.filter(
        ([event]) => event.type === "prompt_first_token_received"
      )
    ).toHaveLength(1);
    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ turnId: "stale-turn" })
    );

    monitor.dispose();
  });

  it("stops inspecting stream deltas after reporting the first token", () => {
    const nowUnixMs = vi.fn(() => 2_000);
    const harness = createEngineHarness(
      engineState({
        submits: {
          "submit-1": pendingSubmit({ status: "accepted", turnId: "turn-1" })
        }
      })
    );
    const onEvent = vi.fn();
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      nowUnixMs,
      onEvent,
      subscribeSessionEvents: harness.subscribeSessionEvents
    });
    const firstToken = messageDelta({ turnId: "turn-1" });

    harness.emitSessionEvent(firstToken);
    const callsAfterFirstToken = nowUnixMs.mock.calls.length;
    for (let index = 0; index < 100; index += 1) {
      harness.emitSessionEvent(firstToken);
    }

    expect(nowUnixMs).toHaveBeenCalledTimes(callsAfterFirstToken);
    expect(
      onEvent.mock.calls.filter(
        ([event]) => event.type === "prompt_first_token_received"
      )
    ).toHaveLength(1);

    monitor.dispose();
  });

  it("skips unchanged pending intents on unrelated engine notifications", () => {
    const nowUnixMs = vi.fn(() => 1_000);
    const harness = createEngineHarness(engineState({}));
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      nowUnixMs,
      onEvent: vi.fn(),
      subscribeSessionEvents: harness.subscribeSessionEvents
    });
    const callsAfterInitialState = nowUnixMs.mock.calls.length;

    for (let index = 0; index < 100; index += 1) {
      harness.notifyEngine();
    }

    expect(nowUnixMs).toHaveBeenCalledTimes(callsAfterInitialState);

    monitor.dispose();
  });

  it("reports activation, initial-prompt admission, first token, and settled Turn", () => {
    let nowUnixMs = 10_000;
    const activation = pendingActivation({ status: "requested" });
    const harness = createEngineHarness(
      engineState({ activations: { "activation-1": activation } })
    );
    const onEvent = vi.fn();
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      nowUnixMs: () => nowUnixMs,
      onEvent,
      subscribeSessionEvents: harness.subscribeSessionEvents
    });

    nowUnixMs = 11_200;
    harness.setState(
      engineState({
        activations: {
          "activation-1": pendingActivation({ status: "confirmed" })
        }
      })
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandDurationMs: 1_100,
        commandOutcome: "succeeded",
        durationBucket: "1s_to_3s",
        durationMs: 1_200,
        lastObservedStage: "confirmed",
        mode: "new",
        outcome: "confirmed",
        snapshotDurationMs: 1_200,
        snapshotOutcome: "matched",
        type: "session_activation_settled"
      })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 1_200,
        operationId: "submit-new",
        outcome: "accepted",
        source: "activation",
        type: "prompt_admission_settled"
      })
    );

    nowUnixMs = 12_000;
    harness.emitSessionEvent(
      messageDelta({
        content: { operation: "set", value: [{ text: "private token" }] },
        kind: "plan",
        turnId: "turn-new"
      })
    );
    harness.emitSessionEvent(
      messageDelta({ role: "user", turnId: "turn-new" })
    );
    harness.emitSessionEvent(messageDelta({ text: "  ", turnId: "turn-new" }));

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 2_000,
        firstTokenKind: "plan",
        operationId: "submit-new",
        source: "activation",
        turnId: "turn-new",
        type: "prompt_first_token_received"
      })
    );
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain("private token");

    harness.setState(
      engineState({
        activations: {
          "activation-1": pendingActivation({ status: "confirmed" })
        },
        turns: {
          [canonicalTurnKey("session-1", "turn-new")]: {
            agentSessionId: "session-1",
            origin: "user_prompt",
            outcome: "completed",
            phase: "settled",
            settledAtUnixMs: 13_000,
            startedAtUnixMs: 10_500,
            turnId: "turn-new",
            updatedAtUnixMs: 13_000
          }
        }
      })
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        durationBucket: "1s_to_3s",
        durationMs: 2_500,
        outcome: "completed",
        turnId: "turn-new",
        type: "turn_settled"
      })
    );

    monitor.dispose();
  });

  it("waits for a late activation command result after snapshot confirmation", () => {
    let nowUnixMs = 11_200;
    const harness = createEngineHarness(
      engineState({
        activations: {
          "activation-1": pendingActivation({
            commandOutcome: "pending",
            commandSettledAtUnixMs: null,
            snapshotObservedAtUnixMs: 11_200,
            status: "confirmed"
          })
        }
      })
    );
    const onEvent = vi.fn();
    const monitor = createAgentGUIPerformanceMonitor({
      engine: harness.engine,
      nowUnixMs: () => nowUnixMs,
      onEvent,
      subscribeSessionEvents: harness.subscribeSessionEvents
    });

    expect(
      onEvent.mock.calls.filter(
        ([event]) => event.type === "session_activation_settled"
      )
    ).toHaveLength(0);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "submit-new",
        outcome: "accepted",
        type: "prompt_admission_settled"
      })
    );

    nowUnixMs = 11_500;
    harness.setState(
      engineState({
        activations: {
          "activation-1": pendingActivation({
            commandOutcome: "succeeded",
            commandSettledAtUnixMs: 11_500,
            snapshotObservedAtUnixMs: 11_200,
            status: "confirmed"
          })
        }
      })
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        commandDurationMs: 1_500,
        commandOutcome: "succeeded",
        durationMs: 1_500,
        snapshotDurationMs: 1_200,
        snapshotOutcome: "matched",
        type: "session_activation_settled"
      })
    );
    expect(
      onEvent.mock.calls.filter(
        ([event]) => event.type === "prompt_admission_settled"
      )
    ).toHaveLength(1);
    monitor.dispose();
  });
});

function createEngineHarness(initialState: AgentSessionEngineState) {
  let state = initialState;
  const engineListeners = new Set<() => void>();
  const sessionListeners = new Set<(event: unknown) => void>();
  const engine = {
    getSnapshot: () => state,
    identity: { origin: "local", workspaceId: "workspace-1" },
    subscribe: (listener: () => void) => {
      engineListeners.add(listener);
      return () => engineListeners.delete(listener);
    }
  } as unknown as AgentSessionEngine;
  return {
    emitSessionEvent(event: unknown) {
      for (const listener of sessionListeners) listener(event);
    },
    engine,
    notifyEngine() {
      for (const listener of engineListeners) listener();
    },
    setState(nextState: AgentSessionEngineState) {
      state = nextState;
      for (const listener of engineListeners) listener();
    },
    subscribeSessionEvents(listener: (event: unknown) => void) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    }
  };
}

function engineState(input: {
  activations?: Record<string, ReturnType<typeof pendingActivation>>;
  submits?: Record<string, ReturnType<typeof pendingSubmit>>;
  turns?: Record<string, Record<string, unknown>>;
}): AgentSessionEngineState {
  return {
    pendingIntents: {
      activationsByRequestId: input.activations ?? {},
      inactiveSessionIds: {},
      submitsByClientSubmitId: input.submits ?? {}
    },
    sessionLifecycle: {
      sessionsById: {
        "session-1": {
          agentSessionId: "session-1",
          provider: "codex"
        }
      },
      turnsById: input.turns ?? {}
    }
  } as unknown as AgentSessionEngineState;
}

function pendingSubmit(input: {
  status: "accepted" | "requested";
  turnId: string | null;
}) {
  return {
    acceptedSessionVersion: null,
    agentSessionId: "session-1",
    clientSubmitId: "submit-1",
    content: [{ text: "prompt", type: "text" as const }],
    errorCode: null,
    errorMessage: null,
    expiresAtUnixMs: 121_000,
    requestedAtUnixMs: 1_000,
    status: input.status,
    submitDiagnostics: {
      queued: true,
      source: "agent-gui",
      submittedAtUnixMs: 1_000
    },
    turnId: input.turnId,
    workspaceId: "workspace-1"
  };
}

function pendingActivation(input: {
  commandOutcome?: "pending" | "succeeded";
  commandSettledAtUnixMs?: number | null;
  snapshotObservedAtUnixMs?: number | null;
  status: "confirmed" | "requested";
}) {
  return {
    agentSessionId: "session-1",
    agentTargetId: "codex",
    clientSubmitId: "submit-new",
    commandOutcome:
      input.commandOutcome ??
      (input.status === "confirmed" ? "succeeded" : "pending"),
    commandSettledAtUnixMs:
      input.commandSettledAtUnixMs ??
      (input.status === "confirmed" ? 11_100 : null),
    content: [{ text: "prompt", type: "text" as const }],
    cwd: "/workspace",
    errorCode: null,
    errorMessage: null,
    expiresAtUnixMs: 130_000,
    initialPromptRetracted: false,
    initialTurnExpected: true,
    lastObservedStage:
      input.status === "confirmed"
        ? ("confirmed" as const)
        : ("requested" as const),
    mode: "new" as const,
    requestId: "activation-1",
    requestedAtUnixMs: 10_000,
    status: input.status,
    snapshotObservedAtUnixMs:
      input.snapshotObservedAtUnixMs ??
      (input.status === "confirmed" ? 11_200 : null),
    snapshotOutcome:
      input.status === "confirmed"
        ? ("matched" as const)
        : ("not_observed" as const),
    submitDiagnostics: {
      queued: false,
      source: "agent-gui",
      submittedAtUnixMs: 10_000
    },
    title: null,
    workspaceId: "workspace-1"
  };
}

function messageDelta(input: {
  content?: Record<string, unknown>;
  kind?: string;
  role?: string;
  text?: string;
  turnId: string;
}) {
  return {
    agentSessionId: "session-1",
    data: {
      agentSessionId: "session-1",
      content: input.content ?? {
        operation: "append_text",
        text: input.text ?? "token"
      },
      eventType: "message_delta",
      kind: input.kind ?? "text",
      messageId: `message-${input.turnId}`,
      occurredAtUnixMs: 1,
      role: input.role ?? "assistant",
      turnId: input.turnId,
      workspaceId: "workspace-1"
    },
    eventType: "message_delta",
    workspaceId: "workspace-1"
  };
}
