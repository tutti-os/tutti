# Unit Testing

This document contains Tutti's durable test-design rules. The executable
authoring and review workflow lives in `$tutti-test-audit`; test discovery,
commands, changed-aware validation, performance scenarios, and Session Replay
live in [Testing](./testing.md).

Apply these rules to new and materially rewritten tests. They do not require a
mass rewrite of legacy suites, but a touched test must not preserve a known
low-value pattern without reason.

## Quality bar

A test earns its place when it protects a product contract that a plausible
implementation mistake could violate. It must execute the production owner and
observe a stable result at a boundary capable of exposing that mistake.

Start with this statement:

```text
When ACTION occurs under CONDITION, the owner must produce OUTCOME while
preserving or avoiding NON_EFFECT. A faulty implementation that REGRESSION
must make this test fail.
```

A merge-worthy test has all of these properties:

- **Contract:** it protects observable behavior, an invariant, compatibility,
  or a previously observed failure that matters.
- **Sensitivity:** a credible wrong implementation, including the old bug for a
  regression, fails an assertion for the intended reason.
- **Fidelity:** it invokes the production owner through the lowest credible
  boundary instead of reproducing or mocking away the behavior.
- **Oracle:** it asserts stable outcomes and important non-effects rather than
  incidental structure.
- **Determinism:** time, concurrency, randomness, state, and external resources
  produce the same verdict on a busy runner.
- **Execution:** the blocking repository lane discovers the test, and every
  platform-specific arm runs on its native platform.

Adding no test is preferable to adding evidence that only restates a constant,
type, mock arrangement, or presentation detail. Test count, assertion count,
and line coverage are diagnostic metrics, not quality verdicts.

## Choose the lowest credible boundary

“Unit” describes isolation, not importance. Use the lowest level that can
observe the named risk without replacing it.

| Level                 | Appropriate risk                                                           | Boundary that remains real                |
| --------------------- | -------------------------------------------------------------------------- | ----------------------------------------- |
| Pure unit             | Parsing, normalization, projection, policy, deterministic algorithms       | None                                      |
| Behavioral component  | One controller, store, service, or UI interaction                          | Internal production wiring                |
| Conformance           | A contract shared by implementations or consumers                          | Public contract and driver                |
| Narrow integration    | SQLite, filesystem, Git, HTTP, IPC, parser, subprocess, or OS semantics    | The boundary named by the risk            |
| End to end            | A journey through a composition root                                       | Public entry point to user-visible result |
| Visual or performance | Pixels, layout, animation, responsiveness, or timing budgets               | Real renderer or trace                    |
| Repository check      | Imports, generated artifacts, manifests, ownership, or source architecture | Repository files themselves               |

A test named E2E that bypasses the composition root and replaces all internal
collaborators is a component test. A colocated test that launches a real
subprocess is an integration test.

Prefer one vertical proof through the owning boundary plus narrow unit cases for
important decisions. A helper-only unit test cannot prove that production
callers still invoke the helper. Tutti has encountered this exact failure with
remote-image materialization; see the
[troubleshooting entry](./troubleshooting/agent-session-lifecycle.md#remote-agent-image-reaches-the-provider-as-an-unsupported-url).

### Tutti routing rules

- New Session, Turn, Goal, runtime-operation, or recovery semantics start as a
  scenario in `packages/agent/host/conformance`. Consumer adapters implement
  drivers; they do not clone lifecycle semantics.
- Adapter tests own transport, DTO, authorization, query, presentation, and
  product-policy behavior.
- SQLite, filesystem, paths, Git, command quoting, executable discovery,
  process lifecycle, IPC, and native API behavior require a real isolated
  instance of the relevant boundary.
- UI behavior belongs in a behavioral component test that drives accessible
  keyboard, pointer, focus, or state transitions. Pixels and layout belong in
  visual evidence.
- HTTP and provider protocol behavior should cross the real parser, middleware,
  codec, or receiver when that behavior is the risk.
- Host filesystem, shell, process, registry, signal, permission, and executable
  behavior must run on the native OS. A request-shape assertion cannot replace
  the receiving Windows API or process boundary.

## Design from risk

Identify the module that owns the decision and the boundary where a caller can
observe it. Stable observations include:

- returned domain values and typed errors;
- canonical or persisted state read through the owning store;
- emitted events and observable ordering;
- the final provider, HTTP, IPC, parser, or process request;
- filesystem contents, permissions, and executable behavior;
- accessible UI state, callbacks, enabled actions, and focus;
- absence of a write, dispatch, retry, duplicate, secret, or leaked resource.

Select only input partitions that can change the decision or represent a real
failure mode: missing and malformed input, exact boundaries, identity reuse,
ordering, partial failure, response loss, restart, cancellation, competing
writers, preservation of unrelated state, and native-platform differences.

One test may use several assertions when they jointly prove one behavior. Test
names should state cause and observable effect, such as `retries transient
catalog failures but not permanent failures`, rather than `works` or a private
method name.

### Prove regression sensitivity

Capture a confirmed bug's failing reproduction before the fix whenever safe.
The resulting regression test must fail on pre-fix behavior for the intended
reason. If the old revision cannot run, temporarily restore or inject the faulty
decision as a local negative control; do not commit that mutation.

For new behavior, first show that the focused test fails because the contract is
missing, not because test setup, imports, or fixtures are broken. When
sensitivity is not obvious, include the negative-control evidence in the PR.

## Assert contracts, not implementation shape

Prefer observations in this order:

1. externally visible result or typed error;
2. durable state and preservation of unrelated state;
3. event or protocol sequence at an owned boundary;
4. side-effect count when count is itself the contract;
5. a narrow internal observation only when no stable boundary exists.

Failure-path tests should normally assert both what happened and what did not:
no provider request, no canonical row, no rollback of an earlier commit, no
stale output, no secret in diagnostics, or no new identity during a retry.
`does not throw` or `err == nil` alone is rarely a sufficient oracle.

### Prefer invariants to change detectors

A change detector freezes data expected to evolve: an exact catalog size,
current model name, schema-version literal, copied defaults object, snapshot of
a registry, or duplicated lookup table. Protect the relationship consumers rely
on instead: every selectable model has required metadata, migrations end at the
declared current version, identities stay unique, or forbidden sets do not
overlap.

Use snapshots only for deliberately stable public serialization, generated
contracts, or normalized CLI output. Keep them small, normalize paths, IDs,
time, width, and platform noise, and pair them with semantic assertions.

### Keep source contracts out of runtime unit tests

A runtime test must not read production `.go`, `.ts`, or `.tsx` text and use a
string, regex, or `indexOf` as proof that a call or option is wired correctly.
Execute the runtime seam or extract the real decision into its owner.

When source shape is intentionally the contract—imports, generated files,
manifests, architecture, or security policy—implement a named repository check
under `tools/scripts` and register it with the repository-check infrastructure.
That check is valuable, but it is not runtime unit coverage.

## Use real owned resources and narrow doubles

Use temporary real implementations when their semantics are part of the risk:
SQLite for transactions and recovery, a filesystem for paths and atomic writes,
a local HTTP server for redirects and streaming, a temporary Git repository for
worktree behavior, and a subprocess or parser for quoting and wire contracts.

Use a double when the collaborator is externally owned, nondeterministic,
unsafe, or irrelevant to the current decision. A double should implement the
smallest owning port, return explicit configured outcomes, fail immediately on
unexpected calls, and capture only contract observations. Never make every
method silently succeed. A test that stubs every layer and verifies that the
stubs called one another proves its arrangement, not the product.

Isolate state before production imports can capture it. Tests must not read or
write real Tutti state, credentials, provider configuration, user Git config,
or developer services. Always restore environment variables, clocks, globals,
listeners, timers, stores, sockets, subprocesses, and temporary resources,
including on failure.

## Make concurrency deterministic

Express the required happens-before relationship with signals:

1. operation A reaches a named gate;
2. operation B is submitted while A is held;
3. the test observes the contract in that state;
4. the gate is released;
5. both operations settle and final state is asserted.

Use channels, barriers, latches, deferred values, or domain events. A timeout is
a generous deadlock guard around an awaited signal, not readiness evidence or
the behavioral oracle. “Nothing happened for 20 ms” does not prove that nothing
can happen.

Inject clocks, timers, deadline errors, random sources, IDs, or schedulers when
the decision depends on them. Test immediately before, at, and after thresholds.
Retries may expose a flake, but they do not repair it; a pass-on-retry must remain
visible as a defect.

## Preserve suite and CI integrity

- Keep small suites beside their owner. Split large lifecycle, recovery,
  concurrency, migration, rendering, or platform scenarios by behavior rather
  than creating one file per private helper or one giant suite.
- Keep tests order-independent. Parallelize only when they do not share mutable
  globals, environment, ports, clocks, files, or fixtures.
- Every test must be discovered by its package command and the appropriate root
  changed-aware lane. A selected suite that collects zero tests must fail.
- Empty files, committed `.only`, required missing fixtures, and suites whose
  meaningful cases all skip are defects.
- Platform markers, build tags, and filename filters must map to a blocking
  native CI lane.
- Keep unit tests offline. Live-provider qualification belongs in an explicit,
  isolated lane or sanitized record/replay workflow.

Coverage can identify unvisited branches, but a repository-wide percentage
rewards shallow render tests, copied constants, and mocked call graphs. For
critical lifecycle, authorization, persistence, recovery, and security logic,
targeted fault injection or mutation sampling is a stronger audit.

## Repository examples

Use these as patterns for their specific risks, not as templates to copy:

- [Agent Host conformance](../../packages/agent/host/conformance/scenarios.go)
  expresses lifecycle behavior once for multiple consumers.
- [Managed runtime tests](../../services/tuttid/service/managedruntime/runtime_test.go)
  distinguish transient and permanent failures, use a local HTTP server, and
  assert retries, cancellation, and response cleanup.
- [Combobox behavior](../../packages/ui/system/src/components/combobox/combobox.spec.tsx)
  drives keyboard and pointer actions and observes selection, disabled behavior,
  filtering, accessibility, and closure.
- [Windows Codex contract](../../packages/agent/daemon/runtime/codex_appserver_windows_contract_test.go)
  checks behavior against the real Windows receiver instead of trusting a
  serialized request shape.
