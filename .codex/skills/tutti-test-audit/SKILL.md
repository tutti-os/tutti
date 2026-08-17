---
name: tutti-test-audit
description: Audit, design, write, materially revise, or remove Tutti tests. Use whenever Codex changes or reviews unit, component, conformance, integration, regression, platform, or repository tests; enforce a protected product contract, credible failure, correct owning boundary, negative-control evidence, overlap review, deterministic setup, and an executing CI lane.
---

# Tutti Test Audit

Make every changed test earn its maintenance cost. A green test, a coverage
increase, or a larger test count is not a quality verdict.

Read the root and closest scoped `AGENTS.md`, then read
`docs/conventions/unit-testing.md` before a non-trivial test change or review.
Follow `docs/conventions/testing.md#validation-selection` for commands and
validation scope.

## Establish the evidence map

Before editing, inspect:

1. the production owner, public entry point, relevant caller and callee;
2. sibling implementations that share the same invariant;
3. existing tests, fixtures, conformance suites, and repository checks;
4. the changed-aware and platform lane that will select the evidence;
5. relevant history for a regression or a suspicious existing test.

For Agent Host lifecycle semantics, also read
`packages/agent/host/README.md` and start with the conformance contract. Do not
reimplement lifecycle tests in an adapter.

## Pass the authoring gate

Answer all six questions before adding or materially rewriting a test:

1. **Protected contract:** What observable behavior, invariant, compatibility
   promise, or prior failure matters?
2. **Credible failure:** What plausible faulty implementation must make the
   test fail?
3. **Coverage gap:** Why would existing evidence not catch that failure? Can an
   existing table, scenario, or fixture express it without duplication?
4. **Owner and observer:** Which module owns the decision, and what is the
   lowest boundary that can observe the risk without mocking it away?
5. **Production seam:** Does the test require an export, flag, wrapper, global,
   or injection hook that no production caller needs? If so, move to the real
   boundary or redesign the owner.
6. **Execution:** Which blocking lane selects the test, and which native OS must
   execute it?

A missing answer means the test is not ready. “No new test” is a valid outcome
when stronger existing evidence already protects the contract or the proposed
assertion only restates a type, literal, implementation detail, or presentation
choice.

## Choose the proof shape

- Extend an existing table or conformance scenario when it owns the same
  contract and fixture.
- Add a new scenario when the behavior, failure mechanism, setup, or execution
  lane is independently meaningful.
- Move upward to a component, narrow integration, conformance, or E2E boundary
  when a unit double would replace the semantics under test.
- Use a repository check, not a unit test, when source structure, imports,
  generated artifacts, manifests, or architecture are the actual contract.
- Keep visual styling in visual evidence unless styling changes native behavior
  such as pointer ownership or window dragging.

Prefer one vertical proof through the owning boundary plus narrow tests for
important decision partitions over many stub-backed branch tests.

## Build sensitive evidence

For a confirmed bug, capture the failing reproduction before the fix whenever
possible. The regression test must fail on pre-fix behavior for the intended
reason and pass after the owner-boundary repair. If the old revision cannot be
run safely, temporarily inject or restore the faulty decision as a local
negative control and report that limitation; never commit the mutation.

For new behavior, first demonstrate that the focused test fails because the
contract is absent, not because setup, imports, or fixtures are broken.

For a read-only audit, do not edit production code merely to manufacture a
negative control. Name the smallest plausible faulty implementation, determine
whether the current assertions would detect it, and label that sensitivity
unverified when it cannot be executed safely.

Then:

- assert stable outcomes and important non-effects;
- include neighboring valid, rejection, cleanup, retry, or preservation cases
  only when they address a credible risk;
- use real isolated SQLite, filesystem, Git, HTTP, IPC, parser, or process
  boundaries when their semantics are the subject;
- keep external doubles narrow and fail closed on unexpected calls;
- coordinate concurrency with events, channels, barriers, or latches rather
  than sleeps or lucky elapsed-time bounds;
- control clocks, IDs, randomness, ports, user state, credentials, globals,
  listeners, timers, processes, and temporary resources;
- assert call counts only when count is itself a contract such as idempotency,
  single-flight, or at-most-once dispatch.

## Apply Tutti routing

- Session, Turn, Goal, runtime-operation, and recovery semantics start in
  `packages/agent/host/conformance`; consumers provide drivers.
- Adapter tests own transport, DTO, authorization, query, presentation, and
  product-policy behavior only.
- SQLite, filesystem, path, shell, executable, process, signal, permission, and
  native API behavior cross the real isolated receiver boundary.
- UI behavior drives accessible keyboard, pointer, focus, and state transitions
  and observes callbacks or user-visible state.
- HTTP, IPC, and provider protocol tests cross the real parser, middleware, or
  codec boundary when receiver behavior is the risk.
- Platform-dependent behavior runs on the native platform. A serialized
  request shape or a skipped Linux test is not Windows proof.

## Audit existing tests

Treat these as review candidates, not automatic deletions:

- no meaningful assertion, self-comparison, or only “does not throw”;
- copied production algorithm, catalog, defaults, or current inventory;
- source strings or regexes presented as runtime behavior proof;
- private call-shape or mocked call-graph assertions;
- static render, class, style, SVG path, or incidental DOM assertions;
- duplicate coverage weaker than an existing boundary scenario;
- sleeps, polling delays, pass-on-retry, silent skips, or zero-selected lanes;
- test-only production exports, wrappers, flags, globals, or dead code.

Before weakening or removing a test, identify the failure it can actually catch,
its history, and the stronger evidence that remains. Preserve independent
public API, protocol, config, migration, storage, security, platform, generated,
release, and architecture contracts even when they are static or slow.

Classify each candidate as:

- **keep** — protects an independent contract;
- **strengthen or move** — right risk, wrong oracle or boundary;
- **consolidate** — useful contract already has a canonical owner;
- **delete** — no credible failure remains protected, including any test-only
  production seam it kept alive.

## Validate and hand off

1. Run the smallest owner and sibling tests that prove the contract.
2. For authored behavior changes, demonstrate the pre-fix failure or another
   credible negative control. For a read-only audit, report the failure model
   without mutating the checkout.
3. Apply the repository validation-selection policy; verify the intended lane
   selected and ran non-zero evidence.
4. Run native-platform proof when required, or name the remaining manual gate.
5. Inspect the final diff for duplicated setup, weakened assertions, snapshot
   churn, leaked resources, and unnecessary production seams.

Report this compact evidence for non-trivial test changes:

```md
Test evidence

- Protected contract or prior failure:
- Credible faulty implementation / negative control:
- Existing coverage gap:
- Owning seam and test level:
- Observable outcomes and important non-effects:
- Blocking lane and native OS, when relevant:
- Residual risk left to integration, E2E, visual, or manual proof:
```
