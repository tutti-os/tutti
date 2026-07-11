import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTuttiExternalCapabilities } from "./capabilities.ts";

test("deduplicates and freezes valid host capabilities", () => {
  const capabilities = normalizeTuttiExternalCapabilities({
    atProviders: ["file", "file"],
    managedAiProviders: ["openai", "openai"],
    operations: ["app.getContext", "app.getContext"],
    workspaceAgentProviders: ["codex", "codex"],
    workspaceFeatures: ["agent-chat", "agent-chat"]
  });
  assert.deepEqual(capabilities, {
    atProviders: ["file"],
    managedAiProviders: ["openai"],
    operations: ["app.getContext"],
    workspaceAgentProviders: ["codex"],
    workspaceFeatures: ["agent-chat"]
  });
  assert.equal(Object.isFrozen(capabilities), true);
  for (const value of Object.values(capabilities)) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("rejects malformed host capability domains", () => {
  const sparseOperations: unknown[] = [];
  sparseOperations.length = 1;
  const sparseAtProviders: unknown[] = [];
  sparseAtProviders.length = 1;
  const iteratorMaskedSparseOperations: unknown[] = [];
  iteratorMaskedSparseOperations.length = 1;
  iteratorMaskedSparseOperations[Symbol.iterator] = () =>
    new Array<unknown>()[Symbol.iterator]();
  for (const capabilities of [
    { operations: ["not.real"] },
    { atProviders: ["evil"], operations: [] },
    { managedAiProviders: ["evil"], operations: [] },
    { operations: [], workspaceAgentProviders: ["evil"] },
    { operations: [], workspaceFeatures: ["evil"] },
    { atProviders: null, operations: [] },
    { operations: null },
    { operations: sparseOperations },
    { operations: iteratorMaskedSparseOperations },
    { atProviders: sparseAtProviders, operations: [] }
  ]) {
    assert.throws(
      () => normalizeTuttiExternalCapabilities(capabilities as never),
      /capabilities (are invalid|must be an object)/
    );
  }
});

test("reads each capability entry once before validating it", () => {
  let reads = 0;
  const operations: unknown[] = [];
  Object.defineProperty(operations, 0, {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? "app.getContext" : "evil";
    }
  });
  operations.length = 1;

  assert.deepEqual(
    normalizeTuttiExternalCapabilities({ operations } as never),
    {
      operations: ["app.getContext"]
    }
  );
  assert.equal(reads, 1);
});
