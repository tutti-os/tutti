import { describe, expect, it, vi } from "vitest";
import type { AgentGUITargetConnectionState } from "../../../types";
import type {
  AgentGuiScheduledTask,
  AgentGuiScheduler
} from "../agentGuiScheduler";
import {
  AgentGUITargetConnectionController,
  AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS
} from "./AgentGUITargetConnectionController";

class FakeConnectionSource {
  private readonly listeners = new Set<() => void>();
  constructor(private state: AgentGUITargetConnectionState | null) {}

  readonly getSnapshot = (): AgentGUITargetConnectionState | null => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(state: AgentGUITargetConnectionState | null): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeScheduler implements AgentGuiScheduler {
  private task: (() => void) | null = null;
  lastDelayMs: number | null = null;

  schedule(delayMs: number, task: () => void): AgentGuiScheduledTask {
    this.lastDelayMs = delayMs;
    this.task = task;
    return {
      cancel: () => {
        if (this.task === task) this.task = null;
      }
    };
  }

  run(): void {
    const task = this.task;
    this.task = null;
    task?.();
  }
}

describe("AgentGUITargetConnectionController", () => {
  it("suppresses short connections and reveals persistent connections after 300ms", () => {
    const source = new FakeConnectionSource({
      status: "connecting",
      retryAttempt: 0
    });
    const scheduler = new FakeScheduler();
    const listener = vi.fn();
    const controller = new AgentGUITargetConnectionController({
      scheduler,
      source
    });
    const unsubscribe = controller.subscribe(listener);

    expect(controller.getSnapshot()).toBeNull();
    expect(scheduler.lastDelayMs).toBe(
      AGENT_GUI_TARGET_CONNECTING_NOTICE_DELAY_MS
    );
    source.set({ status: "connected", retryAttempt: 0 });
    scheduler.run();
    expect(controller.getSnapshot()).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    source.set({ status: "connecting", retryAttempt: 0 });
    scheduler.run();
    expect(controller.getSnapshot()).toEqual({
      status: "connecting",
      retryAttempt: 0
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("reveals unavailable immediately and clears it on recovery", () => {
    const source = new FakeConnectionSource({
      status: "unavailable",
      retryAttempt: 0
    });
    const controller = new AgentGUITargetConnectionController({ source });

    expect(controller.getSnapshot()).toEqual({
      status: "unavailable",
      retryAttempt: 0
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    source.set({ status: "connected", retryAttempt: 0 });
    expect(controller.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps unavailable visible until connecting passes the delay", () => {
    const source = new FakeConnectionSource({
      status: "unavailable",
      retryAttempt: 0
    });
    const scheduler = new FakeScheduler();
    const controller = new AgentGUITargetConnectionController({
      scheduler,
      source
    });
    const unsubscribe = controller.subscribe(() => undefined);

    source.set({ status: "connecting", retryAttempt: 1 });
    expect(controller.getSnapshot()).toEqual({
      status: "unavailable",
      retryAttempt: 0
    });

    scheduler.run();
    expect(controller.getSnapshot()).toEqual({
      status: "connecting",
      retryAttempt: 1
    });
    unsubscribe();
  });

  it("publishes retry progress without restarting the visibility delay", () => {
    const source = new FakeConnectionSource({
      status: "connecting",
      retryAttempt: 1
    });
    const scheduler = new FakeScheduler();
    const listener = vi.fn();
    const controller = new AgentGUITargetConnectionController({
      scheduler,
      source
    });
    const unsubscribe = controller.subscribe(listener);

    scheduler.run();
    source.set({ status: "connecting", retryAttempt: 2 });

    expect(controller.getSnapshot()).toEqual({
      status: "connecting",
      retryAttempt: 2
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
