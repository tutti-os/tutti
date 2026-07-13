import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveCoordinator } from "./interactive.ts";
import type { ClaudeSDKSidecarEvent } from "./protocol.ts";

test("interactive coordinator resolves approval on its originating turn", async () => {
  const events: Array<Omit<ClaudeSDKSidecarEvent, "version">> = [];
  const coordinator = createCoordinator(events);
  const resultPromise = coordinator.handleToolPermission(
    "Bash",
    { command: "pwd" },
    {
      signal: new AbortController().signal,
      toolUseID: "tool-1"
    }
  );
  const request = events[0];
  const requestId = String(request?.payload?.requestId);

  coordinator.submit(requestId, "approved", "allow", {});

  assert.deepEqual(await resultPromise, {
    behavior: "allow",
    updatedInput: { command: "pwd" }
  });
  assert.equal(request?.type, "approval_requested");
  assert.equal(request?.payload?.turnId, "turn-1");
  assert.equal(events[1]?.type, "approval_resolved");
  assert.equal(events[1]?.payload?.turnId, "turn-1");
});

test("interactive coordinator rejects all live requests on shutdown", async () => {
  const events: Array<Omit<ClaudeSDKSidecarEvent, "version">> = [];
  const coordinator = createCoordinator(events);
  const resultPromise = coordinator.handleToolPermission(
    "Bash",
    { command: "pwd" },
    { signal: new AbortController().signal }
  );

  coordinator.rejectAll(new Error("session closed"));

  await assert.rejects(resultPromise, /session closed/u);
});

function createCoordinator(
  events: Array<Omit<ClaudeSDKSidecarEvent, "version">>
): InteractiveCoordinator {
  return new InteractiveCoordinator({
    settings: {
      model: "",
      permissionModeId: "default",
      planMode: false,
      effort: "",
      speed: "standard"
    },
    resolveTurnId: () => "turn-1",
    activateSyntheticTurn: () => "synthetic-1",
    emit: (event) => events.push(event)
  });
}
