import type { SessionRuntimeAvailability } from "@tutti-os/agent-activity-core";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentGuiScheduledTask,
  AgentGuiScheduler
} from "../agentGuiScheduler";
import {
  AgentGUITransportAvailabilityController,
  AGENT_GUI_TRANSPORT_RECONNECT_NOTICE_DELAY_MS
} from "./AgentGUITransportAvailabilityController";

class FakeAvailabilitySource {
  private readonly listeners = new Set<() => void>();
  constructor(private availability: SessionRuntimeAvailability | null) {}

  readonly getAvailability = (): SessionRuntimeAvailability | null =>
    this.availability;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(availability: SessionRuntimeAvailability | null): void {
    this.availability = availability;
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

describe("AgentGUITransportAvailabilityController", () => {
  it("suppresses short reconnects and reveals persistent reconnects after 300ms", () => {
    const source = new FakeAvailabilitySource({
      state: "blocked",
      reason: "transport_reconnecting"
    });
    const scheduler = new FakeScheduler();
    const listener = vi.fn();
    const controller = new AgentGUITransportAvailabilityController({
      scheduler,
      source
    });
    const unsubscribe = controller.subscribe(listener);

    expect(controller.getSnapshot()).toBeNull();
    expect(scheduler.lastDelayMs).toBe(
      AGENT_GUI_TRANSPORT_RECONNECT_NOTICE_DELAY_MS
    );
    source.set({ state: "available" });
    scheduler.run();
    expect(controller.getSnapshot()).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    source.set({ state: "blocked", reason: "transport_reconnecting" });
    scheduler.run();
    expect(controller.getSnapshot()).toEqual({
      state: "blocked",
      reason: "transport_reconnecting"
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("reveals unavailable transport immediately and clears it on recovery", () => {
    const source = new FakeAvailabilitySource({
      state: "blocked",
      reason: "transport_unavailable"
    });
    const controller = new AgentGUITransportAvailabilityController({ source });

    expect(controller.getSnapshot()).toEqual({
      state: "blocked",
      reason: "transport_unavailable"
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    source.set({ state: "available" });
    expect(controller.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps the unavailable notice until reconnecting passes the delay", () => {
    const source = new FakeAvailabilitySource({
      state: "blocked",
      reason: "transport_unavailable"
    });
    const scheduler = new FakeScheduler();
    const controller = new AgentGUITransportAvailabilityController({
      scheduler,
      source
    });
    const unsubscribe = controller.subscribe(() => undefined);

    source.set({ state: "blocked", reason: "transport_reconnecting" });
    expect(controller.getSnapshot()).toEqual({
      state: "blocked",
      reason: "transport_unavailable"
    });

    scheduler.run();
    expect(controller.getSnapshot()).toEqual({
      state: "blocked",
      reason: "transport_reconnecting"
    });
    unsubscribe();
  });
});
