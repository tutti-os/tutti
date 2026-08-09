import assert from "node:assert/strict";
import test from "node:test";
import type {
  TerminalDataEvent,
  TerminalTransport
} from "@tutti-os/workspace-terminal/contracts";
import { createTerminalStartupInputGate } from "./terminalStartupInputGate.ts";

test("terminal startup input waits for the declared ready text", async () => {
  const harness = createTransportHarness();
  const gate = createTerminalStartupInputGate({
    commandName: "login",
    readyText: "Welcome to Kimi Code!",
    transport: harness.transport
  });
  const completion = gate.arm("session-1");

  harness.emit({ data: "Welcome to ", sessionId: "session-1" });
  harness.emit({ data: "Kimi Code!", sessionId: "session-1" });

  assert.equal(await completion, "submitted");
  assert.deepEqual(harness.writes, [
    {
      data: "/login\r",
      encoding: "utf8",
      provenance: "auto",
      sessionId: "session-1"
    }
  ]);
});

test("terminal startup input keeps output observed before the session is armed", async () => {
  const harness = createTransportHarness();
  const gate = createTerminalStartupInputGate({
    commandName: "login",
    readyText: "Runtime ready",
    transport: harness.transport
  });
  harness.emit({ data: "Runtime ready", sessionId: "session-2" });

  assert.equal(await gate.arm("session-2"), "submitted");
  assert.equal(harness.writes.length, 1);
});

test("terminal startup input ignores ready text from another terminal", async () => {
  const harness = createTransportHarness();
  const gate = createTerminalStartupInputGate({
    commandName: "login",
    readyText: "Runtime ready",
    timeoutMs: 5,
    transport: harness.transport
  });
  const completion = gate.arm("session-3");
  harness.emit({ data: "Runtime ready", sessionId: "another-session" });

  assert.equal(await completion, "timed_out");
  assert.equal(harness.writes.length, 0);
});

test("terminal startup input reports transport write failures", async () => {
  const harness = createTransportHarness({ writeError: new Error("closed") });
  const gate = createTerminalStartupInputGate({
    commandName: "login",
    readyText: "Runtime ready",
    transport: harness.transport
  });
  const completion = gate.arm("session-4");
  harness.emit({ data: "Runtime ready", sessionId: "session-4" });

  assert.equal(await completion, "write_failed");
});

test("terminal startup input can be cancelled before the runtime is ready", async () => {
  const harness = createTransportHarness();
  const gate = createTerminalStartupInputGate({
    commandName: "login",
    readyText: "Runtime ready",
    transport: harness.transport
  });
  const completion = gate.arm("session-5");
  gate.cancel();
  harness.emit({ data: "Runtime ready", sessionId: "session-5" });

  assert.equal(await completion, "cancelled");
  assert.equal(harness.writes.length, 0);
});

test("terminal startup input ignores noisy terminals after the target is armed", async () => {
  const harness = createTransportHarness();
  const gate = createTerminalStartupInputGate({
    commandName: "login",
    readyText: "Runtime ready",
    transport: harness.transport
  });
  const completion = gate.arm("target-session");
  harness.emit({ data: "Runtime ", sessionId: "target-session" });
  for (let index = 0; index < 16; index += 1) {
    harness.emit({ data: "noisy output", sessionId: `other-${index}` });
  }
  harness.emit({ data: "ready", sessionId: "target-session" });

  assert.equal(await completion, "submitted");
  assert.equal(harness.writes.length, 1);
});

test("terminal startup input rejects unsafe slash command names", async () => {
  const harness = createTransportHarness();
  const gate = createTerminalStartupInputGate({
    commandName: "login now",
    readyText: "Runtime ready",
    transport: harness.transport
  });

  assert.equal(await gate.arm("session-6"), "cancelled");
  assert.equal(harness.writes.length, 0);
});

test("terminal startup input rejects control characters in the ready marker", async () => {
  const harness = createTransportHarness();
  const gate = createTerminalStartupInputGate({
    commandName: "login",
    readyText: "Runtime\nready",
    transport: harness.transport
  });

  assert.equal(await gate.arm("session-7"), "cancelled");
  assert.equal(harness.writes.length, 0);
});

function createTransportHarness(options?: { writeError?: Error }): {
  emit(event: TerminalDataEvent): void;
  transport: Pick<TerminalTransport, "onData" | "write">;
  writes: Array<Parameters<TerminalTransport["write"]>[0]>;
} {
  const listeners = new Set<(event: TerminalDataEvent) => void>();
  const writes: Array<Parameters<TerminalTransport["write"]>[0]> = [];
  return {
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    transport: {
      onData(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async write(request) {
        if (options?.writeError) throw options.writeError;
        writes.push(request);
      }
    },
    writes
  };
}
