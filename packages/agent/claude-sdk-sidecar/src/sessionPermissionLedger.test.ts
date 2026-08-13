import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { SessionPermissionLedger } from "./sessionPermissionLedger.ts";

test("session permission ledger matches exact canonical session updates", () => {
  const ledger = new SessionPermissionLedger();
  const suggestion = {
    type: "addRules",
    behavior: "allow",
    destination: "session",
    rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
  } satisfies PermissionUpdate;

  ledger.remember([suggestion]);

  assert.deepEqual(
    ledger.rehydrate([
      {
        destination: "session",
        rules: [{ ruleContent: "domain:example.com", toolName: "WebFetch" }],
        behavior: "allow",
        type: "addRules",
      },
    ]),
    [suggestion],
  );
  assert.equal(
    ledger.rehydrate([
      {
        ...suggestion,
        rules: [{ toolName: "WebFetch", ruleContent: "domain:other.com" }],
      },
    ]),
    undefined,
  );
});

test("session permission ledger rejects persistent and mixed destinations", () => {
  const ledger = new SessionPermissionLedger();
  const persistent = {
    type: "addDirectories",
    directories: ["/repo"],
    destination: "projectSettings",
  } satisfies PermissionUpdate;
  const session = {
    type: "addDirectories",
    directories: ["/repo"],
    destination: "session",
  } satisfies PermissionUpdate;

  ledger.remember([persistent]);
  ledger.remember([session, persistent]);

  assert.equal(ledger.rehydrate([persistent]), undefined);
  assert.equal(ledger.rehydrate([session]), undefined);
});

test("session permission ledger evicts the oldest exact update at capacity", () => {
  const ledger = new SessionPermissionLedger(1);
  const first = {
    type: "addDirectories",
    directories: ["/repo/first"],
    destination: "session"
  } satisfies PermissionUpdate;
  const second = {
    type: "addDirectories",
    directories: ["/repo/second"],
    destination: "session"
  } satisfies PermissionUpdate;

  ledger.remember([first]);
  ledger.remember([second]);

  assert.equal(ledger.rehydrate([first]), undefined);
  assert.deepEqual(ledger.rehydrate([second]), [second]);
});

test("session permission ledger refreshes recently reused updates", () => {
  const ledger = new SessionPermissionLedger(2);
  const update = (directory: string) =>
    ({
      type: "addDirectories",
      directories: [directory],
      destination: "session",
    }) satisfies PermissionUpdate;
  const first = update("/repo/first");
  const second = update("/repo/second");
  const third = update("/repo/third");

  ledger.remember([first, second]);
  assert.deepEqual(ledger.rehydrate([first]), [first]);
  ledger.remember([third]);

  assert.deepEqual(ledger.rehydrate([first]), [first]);
  assert.equal(ledger.rehydrate([second]), undefined);
});

test("session permission ledger fails closed for cyclic SDK data", () => {
  const cyclic = {
    type: "addDirectories",
    directories: ["C:\\repo"],
    destination: "session",
  } as PermissionUpdate & { cycle?: unknown };
  cyclic.cycle = cyclic;
  const ledger = new SessionPermissionLedger();

  assert.doesNotThrow(() => ledger.remember([cyclic]));
  assert.equal(ledger.rehydrate([cyclic]), undefined);
});

test("session permission ledger matches Windows directory suggestions", () => {
  const ledger = new SessionPermissionLedger();
  const suggestion = {
    type: "addDirectories",
    directories: ["C:\\repo\\src"],
    destination: "session",
  } satisfies PermissionUpdate;

  ledger.remember([suggestion]);

  assert.deepEqual(ledger.rehydrate([structuredClone(suggestion)]), [
    suggestion,
  ]);
});
