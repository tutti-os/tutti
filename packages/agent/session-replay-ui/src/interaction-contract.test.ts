import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  agentSessionReplayIntentContractEntries,
  agentSessionReplayIntentCorrelationCandidates,
  agentSessionReplayIntentCorrelationId,
  isEngineInternalAgentSessionReplayEffectCommand,
  isReplayableAgentSessionActivityEffectCommand,
  rebaseAgentSessionReplayIntentPayload,
  stableAgentSessionReplayEffectFields
} from "./interaction-contract.ts";

interface PortableActivityContract {
  intents: Record<string, { effects: string[]; requiresEffect: boolean }>;
  schemaVersion: number;
}

const portableContract = JSON.parse(
  readFileSync(
    new URL("../../session-replay/activity-contract.json", import.meta.url),
    "utf8"
  )
) as PortableActivityContract;

test("registry mirrors the portable activity contract exactly", () => {
  assert.equal(portableContract.schemaVersion, 1);
  const registryEntries = agentSessionReplayIntentContractEntries();

  assert.deepEqual(
    registryEntries.map(([type]) => type).sort(),
    Object.keys(portableContract.intents).sort()
  );

  for (const [type, contract] of registryEntries) {
    const portable = portableContract.intents[type];
    assert.ok(
      portable,
      `intent ${type} is missing from activity-contract.json`
    );
    assert.deepEqual(
      [...contract.effects].sort(),
      [...portable.effects].sort(),
      `effects for intent ${type} diverge from activity-contract.json`
    );
    assert.equal(
      contract.requiresEffect,
      portable.requiresEffect,
      `requiresEffect for intent ${type} diverges from activity-contract.json`
    );
  }
});

test("every declared effect type is replayable and has stable fields", () => {
  for (const [type, contract] of agentSessionReplayIntentContractEntries()) {
    for (const effectType of contract.effects) {
      assert.ok(
        isReplayableAgentSessionActivityEffectCommand(effectType),
        `effect ${effectType} of intent ${type} is not replayable`
      );
      assert.ok(
        stableAgentSessionReplayEffectFields(effectType),
        `effect ${effectType} of intent ${type} has no stable-field contract`
      );
    }
  }
});

test("correlation extraction prefers the declared key order", () => {
  const activation = {
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    clientSubmitId: "submit-create",
    expiresAtUnixMs: 5_000,
    mode: "new",
    requestedAtUnixMs: 100,
    requestId: "activate-1",
    type: "activation/requested",
    workspaceId: "workspace-1"
  } as const;
  assert.equal(
    agentSessionReplayIntentCorrelationId(activation),
    "submit-create"
  );
  assert.deepEqual(agentSessionReplayIntentCorrelationCandidates(activation), [
    "submit-create",
    "activate-1"
  ]);
});

test("queued prompt identity provides queue/enqueued correlation candidates", () => {
  const enqueued = {
    agentSessionId: "session-1",
    prompt: {
      clientSubmitId: "submit-1",
      content: [{ text: "queued", type: "text" }],
      createdAtUnixMs: 1,
      id: "prompt-1"
    },
    type: "queue/enqueued",
    workspaceId: "workspace-1"
  } as const;
  assert.equal(agentSessionReplayIntentCorrelationId(enqueued), undefined);
  assert.deepEqual(agentSessionReplayIntentCorrelationCandidates(enqueued), [
    "submit-1",
    "prompt-1"
  ]);
});

test("declares engine-internal settings continuations instead of recording them", () => {
  assert.ok(
    isEngineInternalAgentSessionReplayEffectCommand(
      "session/updateSettings",
      "activation-settings:activation-1"
    )
  );
  assert.ok(
    isEngineInternalAgentSessionReplayEffectCommand(
      "session/updateSettings",
      "prompt:settings:queue:send:1"
    )
  );
  assert.equal(
    isEngineInternalAgentSessionReplayEffectCommand(
      "session/updateSettings",
      "settings-1"
    ),
    false
  );
  assert.equal(
    isEngineInternalAgentSessionReplayEffectCommand(
      "turn/cancel",
      "activation-settings:activation-1"
    ),
    false
  );
});

test("rebase rules follow the registry declaration", () => {
  const cancel = rebaseAgentSessionReplayIntentPayload(
    "session/cancelRequested",
    { awaitingTurnExpiresAtUnixMs: 6_000 },
    1_000,
    10_000
  );
  assert.deepEqual(cancel, { awaitingTurnExpiresAtUnixMs: 15_000 });

  const submit = rebaseAgentSessionReplayIntentPayload(
    "submit/requested",
    { expiresAtUnixMs: 125_000, requestedAtUnixMs: 5_000 },
    5_000,
    900_000
  );
  assert.deepEqual(submit, {
    expiresAtUnixMs: 1_020_000,
    requestedAtUnixMs: 900_000
  });

  const untouched = { promptId: "prompt-1" };
  assert.deepEqual(
    rebaseAgentSessionReplayIntentPayload("queue/removed", untouched, 1, 2),
    untouched
  );
});
