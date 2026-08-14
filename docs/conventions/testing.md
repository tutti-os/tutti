# Testing

This document defines the repository-managed test discovery and gate policy.

## Commands

- `pnpm test:ts`: all TypeScript/JavaScript workspace package tests
- `pnpm test:ts -- --packages-json '["@tutti-os/agent-gui"]'`: tests for an
  explicit validated workspace package subset
- `pnpm test:ts -- --shard 1/3`: the first deterministic package shard
- `pnpm test:tools`: repository tool tests only
- `pnpm test:go`: generate builtin app assets, then run the blocking Go workspace test set
- `pnpm test:go:prepared`: run the blocking Go workspace test set when builtin app assets are already prepared
- `pnpm test:go:agent-daemon`: run the blocking agent daemon module as a focused lane

## Validation Selection

Validation entrypoints are scopes, not a cumulative checklist. For normal
non-UI-only work, inspect `pnpm check:changed -- --dry-run`, then run one final
`pnpm check:changed` after the change has settled. The final plan owns its
selected package tests, typechecks, lint, and boundary checks; do not run those
same commands as a separate final preflight or follow-up.

Direct package or boundary commands are iteration tools for a failing or
uncertain surface. After a failed changed-aware run, use
`pnpm check:changed -- --failed-only` after fixing the failure. The runner
rebuilds the current plan, reruns failed, new, and input-changed lanes, and
reuses only lanes that previously passed with the same lane inputs. Retries
inherit the previous run's push-ready mode so failed build or pack lanes remain
in the plan. A focused command run before subsequent edits is evidence for that
iteration, not for the final worktree; some narrow coverage may therefore run
again in the final changed-aware gate.

Add a standalone final check only when the dry-run plan omits a capability the
changed surface requires:

- Desktop runtime/build behavior: `pnpm --filter @tutti-os/desktop build`
- user-visible copy or locale resources: `pnpm check:i18n`
- defaults under `config/tutti.defaults.json`: `pnpm generate:defaults` and `pnpm check:defaults-generated`
- provider strategy/capability contracts: `pnpm check:agent-provider-strategy-boundaries`
- daemon build confidence: `cd services/tuttid && go build ./...`

Use a full package suite or `pnpm check:full` only when broad impact, release
risk, an explicit workflow, or concrete uncertainty in changed-test selection
requires wider confidence. If wider confidence is required, avoid separately
pre-running every boundary/typecheck lane that `check:changed` already owns;
some overlap between its selected tests and an intentionally broader suite may
be unavoidable.

Tests that verify recovery semantics after a timeout should inject the
appropriate deadline error directly instead of depending on a very short
wall-clock timer. Reserve real timers for tests whose subject is the timeout
boundary itself, and give those timers enough scheduling margin for a parallel
CI runner while keeping a separate generous upper-bound assertion. This keeps
provider-timeout behavior distinct from runner scheduling and fixture startup
latency.

`pnpm check:full` prepares builtin app assets once, then uses the prepared Go
lint and test entrypoints. This prevents concurrent validation lanes from
writing the same generated assets. It captures complete task output under
`.tmp/check-full-runs` and prints compact phase summaries by default. Its failed
tasks print filtered error excerpts as soon as they finish; use `--verbose` for
live output or `--tail-lines <n>` to change each failed task's excerpt size.

## Workspace Test Discovery

TypeScript and JavaScript package tests are discovered from workspace
`package.json` files. Every workspace package with a `test` script is included
automatically; do not add package names to a root test whitelist.

Pull-request CI keeps the stable `TypeScript Tests` required-check context but
uses changed-file classification to select package lanes. Package-local changes
run the owning package and transitive workspace dependents' tests; tool-only
changes keep the context as a passing no-op because repository tool tests belong
to `Tooling Consistency`. Lockfile, workspace, shared test configuration, runner,
deleted-package, and relevant root manifest changes run all package tests.
Selected packages are greedily balanced across at most three runner shards by
their discovered test file counts; packages inside each runner remain serial so
their own test workers do not oversubscribe the runner.

A package that declares a `test` script must contain at least one package-local
`*.test.*` or `*.spec.*` file. The root runner rejects zero-test scripts so an
empty glob cannot be reported as a passing test suite. Remove a stale script or
add a real package test.

AgentGUI splits its Vitest suite by required runtime. Plain TypeScript tests run
in Node; TSX tests and the exact TypeScript files listed in
`packages/agent/gui/vitest.config.ts` run in JSDOM. Add a TypeScript test to that
explicit list only when it requires browser globals or DOM behavior. Do not
restore package-wide JSDOM, because most AgentGUI tests exercise DOM-free
models and controllers. The package uses four Vitest threads so its worker pool
matches the public Linux CI runner without stacking package-level concurrency.

Repository tool tests are discovered from `tools/scripts/*.test.mjs`. Tool
tests that exercise package release helpers remain tool-owned instead of being
duplicated through a package-level test script. They are repository contract
tests, not TypeScript package tests, and run through `test:tools` only.

Repository policy, tool contracts, generated contracts, and architecture
boundaries are selected from `tools/scripts/repository-checks.mjs`. Both PR CI
and `check:changed` consume this registry; do not attach a repository-wide
check to a TypeScript or Go lane based on its implementation language.

Go modules are discovered directly from `go.work`; do not maintain a second
module-root registry. The explicit root commands (`pnpm test:go`,
`pnpm test:go:prepared`, and `pnpm lint:go`) remain full-workspace gates.

Changed-aware local validation and pull-request CI share package selection. An
ordinary `.go` change runs tests for the owning package and, when the module is
part of the established Go lint gate, lints that package. A module's `go.mod`
or `go.sum` change expands those checks to the owning module. Changes to
`go.work`, Go validation scripts, the Go PR workflow, or shared golangci-lint
configuration fall back to every test module and every lint-enabled module.
This keeps selection infrastructure self-testing while avoiding full-workspace
Go runs for isolated package changes.

## Local Performance Reports

`pnpm perf:agent-gui` captures and analyzes an AgentGUI interaction scenario
without requiring a manually started Desktop or manually exported trace. It
makes a transactionally consistent SQLite backup of
`~/.tutti-dev/tuttid.db`, clears recoverable operation queues and active AgentGUI
session selection only in that copy, then starts an isolated daemon and
Electron `userData` directory. The source database is never written; the
SQLite source connection enables `query_only` before online backup.
The runner also sets `TUTTI_DESKTOP_PERFORMANCE_HEADLESS=1`; workspace and
standalone Agent windows remain fully rendered for CDP tracing but use zero
opacity, stay out of the taskbar, disable background throttling, and never
activate over the developer's current app. They are also non-focusable and
ignore native mouse events, so pointer input passes through to the underlying
application; CDP-injected scenario input remains available.

Reports and traces are written under
`.tmp/perf/agent-gui/<scenario>/<timestamp>/`. Metric values are
report-only unless the selected scenario declares explicit thresholds.
Startup, semantic scenario assertions, capture, analysis, and declared
threshold failures return a non-zero exit code. Current timing/trace gates are
owned by `virtualized-scroll-locator`, `workbench-window-drag`, and
`workbench-fifty-window-stress`. The command remains local diagnostics, not a
CI performance gate or a stable cross-device benchmark.

The report separates semantic scenario assertions from performance metrics. It
shows start-to-selection, selection-to-stable, and settling phases; restricts
task, layout, paint, and event totals to the selected `CrRendererMain`; and
labels the performance verdict `ungraded` when no comparable baseline or
threshold exists. React component rows link to an unambiguous repository
declaration when static symbol matching succeeds. Those links identify source
ownership, not a runtime call stack or proof of causation.

The capture runner ships `provider-switch`, `session-switch`,
`provider-session-cycle`, `virtualized-streaming`,
`concurrent-agent-streaming`,
`virtualized-scroll-locator`, `virtualized-session-cycle`,
`virtualized-oversized-active-turn`, `browser-behind-agent-gui-pixels`,
`rail-scope-reveal`, `composer-input`, `composer-overflow-resize`,
`workbench-dock-popup-preview`, `workbench-window-lifecycle`,
`workbench-window-drag`, `workbench-fifty-window-stress`,
`desktop-window-state`, and
`provider-status-focus-refresh`. List them with
`--list-scenarios`; select one with
`--scenario <id>`. Scenario modules own preparation, completion conditions,
semantic assertions, milestones, and metadata; runtime startup, trace capture,
renderer analysis, and report rendering stay scenario-neutral.

`workbench-dock-popup-preview` starts with an empty isolated Desktop preview
cache, restores fifty non-minimized AgentGUI windows in the established stress
layout, waits for renderer mutations and idle work to settle, opens the unified
Agent Dock popup, validates all foreground and background preview PNG pixels,
saves a screenshot, and enforces a 50 ms renderer-task budget.

`concurrent-agent-streaming` selects two settled root Sessions, restores them
into two non-overlapping visible AgentGUI windows, and routes each through an
isolated fake Cursor ACP Session. Both Composer forms submit in one renderer
task. The scenario requires both windows to enter working state, render at
least three distinct intermediate assistant-text lengths, reach the final
fixture chunk, and settle before the trace tail. Generic status or spinner DOM
mutations do not satisfy the streaming assertion. It reports the sampled
conversation-projection and streaming-text functions without setting a
cross-device timing threshold.

`virtualized-streaming` and `virtualized-scroll-locator` require one root
Session with at least thirty settled Turns. They change only the isolated copy
to route that Session through the repository's deterministic fake Cursor ACP
executable. Streaming asserts that real daemon events drive repeated React DOM
mutations. Scroll-locator additionally requires four user text messages and
replaces their bodies with a fixed eight-paragraph, three-mention rich-text
fixture. It performs a ten-second monotonic upward scroll over at least eight
viewports, rejects reversed or returning locator selection, and asserts that
historical rows never gain `contenteditable="true"` or `role="textbox"`. Its trace gate
requires at least 300 scroll dispatches, a maximum 50 ms scroll dispatch,
at most 1200 ms total scroll-dispatch time, at most 500 ms `Layout`, at most
1000 ms `UpdateLayoutTree`, and zero inclusive CPU samples for `EditorView`,
`hasSelection`, and `selectionToDOM`. CPU sample counts use
marker-bounded renderer-process `ProfileChunk` stacks; the gate also requires
at least one CPU sample so missing profiler data cannot pass as zero.
`captureScrollAnchor` and `updateStateInner` are reported for diagnosis but are
not thresholds. The active Composer legitimately calls `updateStateInner`
during React passive effects, so that generic ProseMirror function name cannot
distinguish it from a historical message. The historical transcript DOM
assertion remains the ownership gate.
Neither scenario launches or sends input to a developer's installed Agent provider.
`virtualized-session-cycle` uses the same isolated fixture preparation, pairs
one virtualized long Session with one non-virtualized Session of at most three
Turns (and at least one Turn), then performs two round trips. It asserts the exact active Session and
expected virtualization mode after every switch.
`virtualized-oversized-active-turn` retains eighteen settled Turns, then drives
a nineteenth active Turn through the deterministic fake Cursor ACP executable.
The isolated fixture reaches approximately 250 total tool calls, with at least
forty in the active Turn. The trace ends while that Turn is still running and
reports mounted virtual Turn/row counts plus DOM mutation batches. It remains a
local diagnostic without fixed timing thresholds.
`browser-behind-agent-gui-pixels` opens a high-contrast Browser webview, saves a
Browser reference screenshot, then keeps that webview mounted behind a
fullscreen virtualized AgentGUI while the transcript scrolls. It saves the
composited `browser-behind-agent-gui.png` artifact for real-pixel inspection;
its DOM assertions intentionally do not claim a pixel verdict.
`rail-scope-reveal` asserts the exact active-row
`scrollIntoView` call during a fresh Agent scope restore.
`session-switch` also reports inclusive CPU samples for
`readTimelineGeometry`; sample counts are diagnostic stack samples, not
function-call counts.
`composer-overflow-resize` maximizes the AgentGUI Workbench node, narrows the
renderer viewport, asserts the hero prompt-tip's native `scrollWidth` and
`clientWidth` getters were read after resize, then restores the original
viewport metrics.
`composer-input` restores a settled Session so the dock composer is active,
inserts four explicit newline rows, waits for the 3.5-line viewport to finish
expanding, deletes back to one row, and verifies that the action button remains
bottom-aligned across both transitions. It then injects ordinary text one
character at a time, drives a real CDP IME composition lifecycle, opens the `@`
panel, and verifies ArrowDown, Tab, and Escape navigation without submitting
the draft.

`workbench-window-lifecycle` measures the internal AgentGUI Workbench node's
minimize, restore, maximize, unmaximize, close, and reopen mechanics.
`workbench-window-drag` requires at least three mounted AgentGUI Workbench
windows. It drives 120 trusted pointer moves through Chromium and fails when the
startup or drag emits a Chromium tile-memory warning, or when the drag records
more than 20 CSS animation iterations. This catches background AgentGUI
animations that retain too many compositor tiles while windows restore or move.
Before the drag marker starts, the scenario waits for staged background-body
hydration to finish and for the resulting DOM mutations and images to settle,
so startup work is checked separately instead of leaking into the drag window.
`workbench-fifty-window-stress` rewrites only the isolated performance snapshot
to contain exactly 50 mounted AgentGUI nodes. It verifies startup, focuses an
exposed background window without remounting its body, then drags that window.
The scenario rejects tile-memory warnings, any geometrically exposed body that
becomes hidden, more than 20 animation iterations, or a renderer task above
50 ms.
`desktop-window-state` measures the owning Electron window's minimize, restore,
maximize, and unmaximize states through typed host-window APIs and is currently
macOS-only because only that host emits typed minimize-state events. Native
close/reopen is not part of that renderer-marked scenario because closing the
owning native window destroys the renderer that owns the trace boundary
markers. Every declared milestone is required in the captured trace; a missing
marker fails capture instead of silently producing an incomplete phase table.

`provider-status-focus-refresh` dispatches a second workspace focus while the
first focus is being observed, then watches the page for one second. It asserts
that neither focus starts a provider-status request. This guards against window
focus regressing into provider CLI scans without starting an Agent turn. On
macOS, pass `--all-process-time-profile` to also write `time-profile.trace`,
covering Electron, `tuttid`, and short-lived provider CLI child processes that
Chromium CDP tracing cannot see.

Daemon migrations remain forward-only. If the personal dev database was last
opened by a newer checkout with incompatible Agent target migrations, the
command fails before Desktop startup and lists them; use a compatible checkout
or pass a compatible snapshot with `--source-db`. The runner never attempts to
downgrade or rewrite the source database.

## Agent Session Record And Replay

The developer-only runner records and replays an Agent SessionGraph capture
window:

```sh
pnpm e2e:agent-gui -- \
  --record .tmp/cassettes/c01_codex \
  --scenario c01 \
  --scenario-file ../tutti-agent-session-replay-cases/cases/c01/scenario.mjs
pnpm e2e:agent-gui -- --replay .tmp/cassettes/c01_codex
```

Claude Code uses the same runner with an explicit target:

```sh
pnpm e2e:agent-gui -- \
  --record .tmp/cassettes/claude-smoke \
  --scenario claude-smoke \
  --scenario-file /absolute/path/to/claude-smoke.mjs \
  --agent-target-id local:claude-code \
  --timeout-ms 300000
pnpm e2e:agent-gui -- --replay .tmp/cassettes/claude-smoke
```

Recording requires the repository-managed Claude SDK sidecar dependencies, an
installed `claude` CLI, and a successful `claude auth status`. These are live
recording prerequisites only. Replay uses the cassette process transport and
an isolated `CLAUDE_CONFIG_DIR`; it does not require Claude credentials or an
Anthropic request. Start with a pure-text, no-tool scenario before qualifying
tool, approval, cancel, or background-task behavior.

Record mode requires a named external scenario module from the QA case
repository. The scenario declares its preparation, browser actions, and
assertions; the runner only creates the isolated runtime, starts and stops
capture, validates the cassette, and invokes the scenario.
The C01 scenario starts from a newly migrated empty database, creates one
temporary Workspace, and submits three Turns. Cassette `create-session` and
`continue-session` actions remain portable artifact semantics: the latter
captures canonical prior state in `initial-state.json`. Turn settlement and
child creation never stop capture. The user presses the square stop control,
then finalization captures `expected-state.json`.

C04 is the queue-only scenario: it records visible enqueue, edit, remove, and
automatic drain into a distinct next Turn. C06 owns Codex native guidance: a
composer Send now steers the active Turn without rendering a queued-prompt row
or creating a second Turn. Keep these scenarios separate so replay evidence
does not conflate queue lifecycle with provider guidance semantics.

External inputs are represented in the ordered `activity-events.jsonl` stream.
Intent events drive the real activity engine, effect events verify commands
produced by that engine, and direct-stimulus events drive recorded API/CLI
caller paths that did not traverse the activity engine. Engine-origin requests
carry provenance and do not emit duplicate direct events. Provider-created
child Sessions, Goal continuation Turns, and Host worker activity are state
changes, not external inputs, and are never executed twice.
`checkpoint-plan.json` stores the stable playback
boundaries. Intent and its correlated effects form one indivisible Activity
boundary; Provider-observation boundaries use decoded Provider Input Unit
cursors.

`provider/manifest.json` identifies each connection by recorded Session,
provider, and Session-local launch ordinal. `provider/frames.jsonl` carries
connection-local and diagnostic global sequence numbers; the manifest records
the final frame count and SHA-256 digest. Replay matches by that identity
instead of global launch order. It fails on changed outbound bytes, missing inbound frames, extra
connections, leftover frames, or tape-integrity mismatch. Replay asks the
daemon to compare the actual typed Tutti Replay State with the expected state,
not only assistant text.
Inbound provider frames honor their recorded elapsed time at the Replay
surface's selected speed. Matching an outbound frame advances the playback
clock to that recorded boundary, so time spent typing or waiting before a user
action is not replayed. Final verification waits for every scheduled provider
frame to drain after canonical Session settlement; Session idle alone is not
proof that trailing diagnostics were consumed.

The ordered activity stream also honors the relative `occurredAtUnixMs`
timeline. Its runner clock reads the same daemon playback state as provider
transport, so pause, selected speed, and checkpoint fast-forward cannot move
queue, steer, or their effects out of sync with provider frames.

Persisted prompt attachments explicitly referenced by graph messages are copied
to `blobs/sha256/<digest>` and described in `blobs/manifest.json`. Replay
verifies their size and digest, then restores only those attachment targets
under its isolated state directory. Recording never scans or copies the whole
Workspace.

The cassette has no `baseline.db`, raw database rows, scenario/environment
sidecars, or copied Workspace. Replay starts a fresh daemon, which restores the
optional semantic initial state before Host recovery, performs the recorded
Activity Events, and never reads the source user database. See
[Local State Storage](./local-state-storage.md#developer-agent-session-cassettes).
Every Replay Workspace gets a fresh transient Workspace ID. Portable artifacts
contain no source Workspace ID, so Cassettes captured from different
Workspaces can run together. State restore binds the transient Workspace only
inside daemon persistence, and event playback injects only the product
envelope; user payload strings are never recursively rewritten. The Cassette
remains read-only. CDP drives surface navigation and verification;
recorded direct-stimulus activity events use the isolated daemon HTTP API.

`TUTTI_AGENT_CASSETTE_MODE` and `TUTTI_AGENT_CASSETTE_PATH` remain
developer-only static controls for recording and lower-level diagnostics.
Replay Workspace supplies its fixed Cassette/root-Session/directory bindings
through `TUTTI_AGENT_SESSION_REPLAY_REGISTRATIONS`. UI recording does not set
replay composition. Dynamic capture covers live and future connections in the
selected root SessionGraph; provider probes and setup processes continue
through the local transport.

With the developer recording feature enabled, Desktop injects recording and
replay controls through AgentGUI's generic composer-footer accessory slot.
AgentGUI contains no recording/replay domain state or copy. Playing one or
more completed recordings atomically prepares Replay Cassettes and opens one
managed Replay Workspace containing one Agent Session Replay Surface per
Cassette.

## Agent Daemon Blocking Gate

`packages/agent/daemon` is part of the blocking Go workspace test set. A failure
from this module fails `pnpm test:go`, `pnpm check:full`, the pre-push hook, and
the pull-request Go Tests job. Use `pnpm test:go:agent-daemon` when iterating on
the module without running the other Go workspace lanes.

The module was promoted after its known timing-sensitive cases were converted
to event-driven synchronization and the full module passed repeated shuffled
runs. Do not add retries to preserve a green gate; reproduce and stabilize a
failing lifecycle transition instead.

Direct changes to the agent daemon should run the focused lane locally. Use a
repeated shuffled run when changing asynchronous lifecycle behavior.

For asynchronous runtime tests, prefer request/event channels and the session
event sink over fixed-interval polling of mutex-protected slices. Wait for the
specific protocol request or lifecycle event with a descriptive timeout so a
failure identifies the missing transition. Protocol mocks should also cover
valid response/notification reorderings; an RPC response must not be assumed to
arrive before the notifications caused by that request.

Protocol fixtures must answer every synchronous startup/capability probe they
can receive. Return an empty supported result or an explicit method-not-found
error for unsupported probes; never rely on the production RPC timeout as mock
behavior, because one missing response can add tens of seconds to every test
that starts the adapter.

## Output and Logs

Root test runners execute independent lanes with bounded concurrency. Successful
runs print one compact summary plus the three slowest lanes. Each lane writes
its complete output under:

- `.tmp/test-runs/typescript`
- `.tmp/test-runs/go`
- `.tmp/test-runs/go-agent-daemon`

Each root also writes `latest.json`, with per-lane duration, exit code, and log
path, plus a timestamped run directory containing the same `summary.json`.
Inspect that manifest first when an AI agent needs to identify the slow or
failed owner without scanning every log.

Failures print a filtered, bounded excerpt and the full log path as soon as the
lane finishes. Command echoes, package-manager failure wrappers, terminal color
escapes, and consecutive duplicate lines are removed while assertion text,
source locations, and stack frames are preserved. Use `--tail-lines <n>` to
change each displayed failure excerpt and `--max-parallel <n>` to reduce local
resource pressure.

The TypeScript runner uses up to four package lanes locally. CI runs one package
lane at a time because large Vitest packages already own internal worker pools;
stacking package concurrency on a small hosted runner can turn otherwise fast
component tests into timeout failures.

Agent daemon runtime tests suppress the default structured runtime logger to
keep test output bounded. Set `TUTTI_TEST_LOGS=1` for a diagnostic run that
needs the full runtime log stream.

Tests must not inspect or print real local credential snapshots unless the test
explicitly exercises credential storage through isolated fixtures. Node test
runs skip Claude authentication refresh diagnostics so normal unit tests do not
read or expose host credential metadata.

## Unit Test Quality

Agent work that writes, materially rewrites, reviews, or removes tests invokes
`$tutti-test-audit`. The durable design rules live in
[Unit Testing](./unit-testing.md); this document continues to own command and
validation selection.

A test must protect a product contract that a plausible implementation mistake
could violate. It must execute the production owner and observe a stable result;
test count, assertion count, and coverage percentage are not substitutes for
that evidence. In particular:

- test behavior, invariants, state transitions, and important non-effects;
- choose the lowest test level capable of crossing the boundary named by the
  risk;
- do not duplicate production logic or use source regexes to infer runtime
  wiring;
- cross a real isolated boundary when its semantics are the risk; otherwise use
  narrow fail-closed doubles;
- synchronize concurrency with events, channels, barriers, or latches rather
  than short sleeps;
- prove that platform-specific tests execute in a native blocking lane;
- reject constant restatements, mock call-graph tests, style assertions, empty
  or silently skipped evidence, and tests whose old bug would still pass.

Organize tests by behavioral ownership. A small module usually has one colocated
suite; a large seam may split lifecycle, recovery, concurrency, rendering, or
platform scenarios into explicitly named files. Do not trade arbitrary file
fragmentation for giant suites that a reviewer cannot reason about.
