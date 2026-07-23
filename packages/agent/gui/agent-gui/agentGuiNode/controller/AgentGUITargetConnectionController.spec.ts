import { describe, expect, it, vi } from "vitest";
import type { AgentGUITargetConnectionStatus } from "../../../types";
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
  constructor(private status: AgentGUITargetConnectionStatus | null) {}

  readonly getSnapshot = (): AgentGUITargetConnectionStatus | null =>
    this.status;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(status: AgentGUITargetConnectionStatus | null): void {
    this.status = status;
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
    const source = new FakeConnectionSource("connecting");
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
    source.set("connected");
    scheduler.run();
    expect(controller.getSnapshot()).toBeNull();
    expect(listener).not.toHaveBeenCalled();

    source.set("connecting");
    scheduler.run();
    expect(controller.getSnapshot()).toBe("connecting");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("reveals unavailable immediately and clears it on recovery", () => {
    const source = new FakeConnectionSource("unavailable");
    const controller = new AgentGUITargetConnectionController({ source });

    expect(controller.getSnapshot()).toBe("unavailable");
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    source.set("connected");
    expect(controller.getSnapshot()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps unavailable visible until connecting passes the delay", () => {
    const source = new FakeConnectionSource("unavailable");
    const scheduler = new FakeScheduler();
    const controller = new AgentGUITargetConnectionController({
      scheduler,
      source
    });
    const unsubscribe = controller.subscribe(() => undefined);

    source.set("connecting");
    expect(controller.getSnapshot()).toBe("unavailable");

    scheduler.run();
    expect(controller.getSnapshot()).toBe("connecting");
    unsubscribe();
  });
});
