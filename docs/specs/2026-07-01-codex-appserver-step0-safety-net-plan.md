# Codex App-Server Refactor — Step 0 (Characterization Safety Net) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the characterization safety net — an explicit, runnable bug-corpus contract that every later refactor step (1–9) must keep green — without changing any production code.

**Architecture:** The `codex_appserver_*.go` runtime already has a rich test suite that implicitly pins most bug clusters (B/C/D/E). Step 0 makes that net _explicit_ (a cluster→test manifest + a single `go test -run` recipe + a recorded codex version baseline) and _gap-fills_ two thin pure-function spots that the later steps will disturb. This is a **characterization** step: tests capture existing behavior and pass on first run.

**Tech Stack:** Go (`packages/agent/daemon`), package `agentruntime`, standard `testing` (table-driven, `t.Parallel()`).

## Global Constraints

- **No production code changes in Step 0.** Only add test files and one docs file. If a characterization test does not pass against current code, the test's _expectation_ is wrong — fix the test to match observed behavior; never change `*.go` production files here.
- Test package name is `agentruntime` (same as the files under test; these are white-box tests using unexported symbols).
- Every new test uses `t.Parallel()` and the table-driven style already used in `codex_appserver_events_test.go`.
- Work area for build/test: `packages/agent/daemon`. Full corpus command: `go test ./runtime/ -run '<pattern>' -count=1`.
- Design source of truth: `docs/specs/2026-07-01-codex-appserver-refactor-design.md` (§ "The Four State Machines", § "Multi-Step Alignment Plan → Step 0").

---

## File Structure

- Create: `docs/specs/2026-07-01-codex-appserver-bug-corpus.md` — the explicit cluster→test contract manifest + recorded codex baseline version + the corpus run recipe.
- Create: `packages/agent/daemon/runtime/codex_appserver_corpus_test.go` — the two gap-fill characterization tests (collab completed-output; foreign-thread mismatch), grouped and documented as the Step-0-added corpus tests.

No production files are modified.

---

### Task 1: Bug-corpus contract manifest + codex version baseline

**Files:**

- Create: `docs/specs/2026-07-01-codex-appserver-bug-corpus.md`

**Interfaces:**

- Consumes: existing test names (verified present in `codex_appserver_adapter_test.go`, `codex_appserver_collab_test.go`, `codex_appserver_events_test.go`).
- Produces: `<CORPUS_RUN_PATTERN>` — the canonical `go test -run` regex that runs the whole daemon-side corpus; later steps and CI reference it.

- [ ] **Step 1: Capture the codex binary baseline version**

Run (work area `packages/agent/daemon`):

```bash
codex --version 2>/dev/null || codex-cli --version
```

Expected: a line like `codex-cli 0.142.1`. Record the exact version string; it goes into the manifest below as `Baseline codex version`.

- [ ] **Step 2: Write the manifest**

Create `docs/specs/2026-07-01-codex-appserver-bug-corpus.md` with this content (replace `<VERSION>` with the string captured in Step 1):

````markdown
# Codex App-Server Refactor — Bug Corpus (Step 0 Contract)

This is the behavioral safety net for the app-server layer refactor. Every step
(1–9) in `2026-07-01-codex-appserver-refactor-design.md` MUST keep this corpus
green. Where a step replaces a patch with a by-construction fix, the "Will change
in" column names the step allowed to change the test's expectation — any _other_
diff to these tests is a regression.

- Baseline codex version (captured at Step 0): `<VERSION>`
- Corpus run command (work area `packages/agent/daemon`):

  ```bash
  go test ./runtime/ -count=1 -run \
    'TestAppServerCollabAgentFailedCarriesErrorOutput|TestAppServerCollabAgentCompletedCarriesResultOutput|TestAppServerCloseAgentIsControlTool|TestAppServerWaitIsControlTool|TestAppServerForeignThreadMismatch|TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications|TestCodexAppServerAdapterExecStreamsTurn|TestCodexAppServerAdapterSlashCompact|TestCodexAppServerAdapterResumeRetainsReplayedContextUsage|TestCodexAppServerAdapterReleaseLiveSessionClosesClientAndKeepsProviderSession|TestCodexAppServerAdapterReleaseLiveSessionSkipsPendingRequests|TestCodexAppServerAdapterCommandApprovalApprove|TestCodexAppServerAdapterCommandApprovalDecisionMapping|TestCodexAppServerAdapterRequestUserInput|TestAppServerUserInputAnswers'
  ```

| Cluster (state machine)                                              | Pinning test(s)                                                                                                                                                                                     | Origin                                                | Will change in                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **B — thread / sub-agent identity**                                  | `TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications`, `TestAppServerForeignThreadMismatch` (added Step 0)                                                                               | #602                                                  | **Step 3** (drop → route)                                                              |
| **B — sub-agent collab card**                                        | `TestAppServerCollabAgentFailedCarriesErrorOutput`, `TestAppServerCollabAgentCompletedCarriesResultOutput` (added Step 0), `TestAppServerCloseAgentIsControlTool`, `TestAppServerWaitIsControlTool` | #602                                                  | Step 3 (card populated via routing; assertions on card outcome stay)                   |
| **C — turn / compaction lifecycle**                                  | `TestCodexAppServerAdapterExecStreamsTurn`, `TestCodexAppServerAdapterSlashCompact`, `TestCodexAppServerAdapterResumeRetainsReplayedContextUsage`                                                   | log session `67009835`; `4118312f`; `2412b08d`        | Step 5 (explicit state machine; outcomes stay)                                         |
| **D — session / live-session lifecycle**                             | `TestCodexAppServerAdapterReleaseLiveSessionClosesClientAndKeepsProviderSession`, `TestCodexAppServerAdapterReleaseLiveSessionSkipsPendingRequests`                                                 | #604                                                  | Step 7 (facade owns lifecycle; outcomes stay)                                          |
| **E — approval / interactive**                                       | `TestCodexAppServerAdapterCommandApprovalApprove`, `TestCodexAppServerAdapterCommandApprovalDecisionMapping`, `TestCodexAppServerAdapterRequestUserInput`, `TestAppServerUserInputAnswers`          | #418                                                  | Step 6 (resolver extraction; outcomes stay)                                            |
| **A — daemon↔desktop hydration** (desktop-half; out of daemon scope) | GUI: `useAgentGUINodeController.spec.tsx` (#608)                                                                                                                                                    | sessions `7633ebb9`/`2d73bad7`/`08920807`; #608; #585 | **Step 9** (deferred desktop rewrite). Daemon-half contract is authored in **Step 4**. |
````

- [ ] **Step 3: Verify every currently-existing corpus test is green (baseline capture)**

Run (work area `packages/agent/daemon`) — this is the subset that exists _before_ Task 2/3 add their two tests:

```bash
go test ./runtime/ -count=1 -run \
  'TestAppServerCollabAgentFailedCarriesErrorOutput|TestAppServerCloseAgentIsControlTool|TestAppServerWaitIsControlTool|TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications|TestCodexAppServerAdapterExecStreamsTurn|TestCodexAppServerAdapterSlashCompact|TestCodexAppServerAdapterResumeRetainsReplayedContextUsage|TestCodexAppServerAdapterReleaseLiveSessionClosesClientAndKeepsProviderSession|TestCodexAppServerAdapterReleaseLiveSessionSkipsPendingRequests|TestCodexAppServerAdapterCommandApprovalApprove|TestCodexAppServerAdapterCommandApprovalDecisionMapping|TestCodexAppServerAdapterRequestUserInput|TestAppServerUserInputAnswers'
```

Expected: `ok  github.com/tutti-os/tutti/packages/agentactivity/daemon/runtime` (all listed tests PASS). If any test name does not match, correct the manifest to the real name and re-run.

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-07-01-codex-appserver-bug-corpus.md
git commit -m "docs(codex): step0 bug-corpus contract manifest + codex baseline"
```

---

### Task 2: Characterize the collab-agent _completed_-output path (Cluster B gap-fill)

`codex_appserver_collab_test.go` pins the _failed_ collab path (`...FailedCarriesErrorOutput`) but not the _completed-with-result_ path, which `appServerCollabAgentRawOutput` also handles (`result` / `output` / `stdout` / `stderr` keys). Step 3's routing must keep this card-population behavior; pin it now.

**Files:**

- Create: `packages/agent/daemon/runtime/codex_appserver_corpus_test.go`
- Test: same file.

**Interfaces:**

- Consumes: `appServerItemToolCallUpdate(item map[string]any, completed bool) (map[string]any, bool)` and `asString(any) string` (both existing, unexported in package `agentruntime`); `messageStreamStateCompleted` / status handling as exercised in `codex_appserver_collab_test.go`.
- Produces: `TestAppServerCollabAgentCompletedCarriesResultOutput` (referenced by the manifest run pattern).

- [ ] **Step 1: Write the characterization test**

Create `packages/agent/daemon/runtime/codex_appserver_corpus_test.go` with:

```go
package agentruntime

import "testing"

// Step 0 characterization corpus. These tests capture CURRENT behavior of the
// app-server reducer's pure helpers so the layer refactor (steps 1-9) cannot
// silently change it. See docs/specs/2026-07-01-codex-appserver-bug-corpus.md.

// A completed collab (sub-agent) tool call must surface its result/output into
// the parent card's rawOutput. Step 3 keeps this outcome while switching the
// mechanism from drop-filter to thread routing.
func TestAppServerCollabAgentCompletedCarriesResultOutput(t *testing.T) {
	t.Parallel()

	update, ok := appServerItemToolCallUpdate(map[string]any{
		"type":   "collabAgentToolCall",
		"id":     "call-subagent-ok-1",
		"tool":   "spawnAgent",
		"status": "completed",
		"prompt": "Generate one random integer.",
		"result": map[string]any{"integer": 7},
		"output": "7\n",
	}, true)
	if !ok {
		t.Fatalf("update was not produced")
	}
	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	if got := asString(rawOutput["output"]); got != "7\n" {
		t.Fatalf("rawOutput.output = %q, want \"7\\n\"", got)
	}
	result, ok := rawOutput["result"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput.result = %#v, want map", rawOutput["result"])
	}
	if got, _ := acpInt64Value(result["integer"]); got != 7 {
		t.Fatalf("rawOutput.result.integer = %#v, want 7", result["integer"])
	}
}
```

- [ ] **Step 2: Run the test — expect PASS (characterization)**

Run: `go test ./runtime/ -run TestAppServerCollabAgentCompletedCarriesResultOutput -v` (work area `packages/agent/daemon`)
Expected: PASS. If it FAILS, the assertion does not match current behavior — inspect `appServerCollabAgentRawOutput` in `codex_appserver_events.go`, adjust the expected keys/values to what the code actually produces, and re-run. Do **not** edit production code.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/daemon/runtime/codex_appserver_corpus_test.go
git commit -m "test(codex): step0 pin collab-agent completed rawOutput (cluster B)"
```

---

### Task 3: Characterize the foreign-thread drop semantics (Cluster B — the will-change-in-Step-3 pin)

`appServerNotificationThreadMismatch` is #602's drop-filter. Step 3 replaces _dropping_ with _routing_, so this is the single most important behavior to pin explicitly now — the diff in Step 3 must be intentional and visible, not an accidental test edit.

**Files:**

- Modify: `packages/agent/daemon/runtime/codex_appserver_corpus_test.go` (append)

**Interfaces:**

- Consumes: `appServerNotificationThreadMismatch(session Session, method string, params map[string]any) bool` (existing, unexported); `Session` struct with field `ProviderSessionID string` and `AgentSessionID string` (existing); `appServerNotifyItemStarted` — the method-name constant used in existing tests. If the exact constant name differs, mirror the constant used by `TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications` in `codex_appserver_adapter_test.go`.
- Produces: `TestAppServerForeignThreadMismatch` (referenced by the manifest run pattern).

- [ ] **Step 1: Append the characterization test**

Append to `packages/agent/daemon/runtime/codex_appserver_corpus_test.go`:

```go
// CURRENT behavior (#602): a notification whose threadId differs from the
// session's provider thread is dropped (mismatch == true). Step 3 replaces this
// drop with per-thread routing; when Step 3 lands, the "foreign thread" case
// changes from "dropped" to "routed to its own context" and THIS test's
// expectation is updated deliberately. Any earlier change is a regression.
func TestAppServerForeignThreadMismatch(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "s1", ProviderSessionID: "codex-thread-1"}

	cases := []struct {
		name   string
		params map[string]any
		want   bool // true == dropped as foreign
	}{
		{
			name:   "same thread is not dropped",
			params: map[string]any{"threadId": "codex-thread-1", "item": map[string]any{"id": "i1"}},
			want:   false,
		},
		{
			name:   "foreign thread is dropped",
			params: map[string]any{"threadId": "codex-thread-OTHER", "item": map[string]any{"id": "i2"}},
			want:   true,
		},
		{
			name:   "missing event threadId is not dropped",
			params: map[string]any{"item": map[string]any{"id": "i3"}},
			want:   false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := appServerNotificationThreadMismatch(session, appServerNotifyItemStarted, tc.params)
			if got != tc.want {
				t.Fatalf("appServerNotificationThreadMismatch = %v, want %v", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the test — expect PASS (characterization)**

Run: `go test ./runtime/ -run TestAppServerForeignThreadMismatch -v` (work area `packages/agent/daemon`)
Expected: PASS (all three subcases). If the method-name constant `appServerNotifyItemStarted` does not exist, replace it with the exact notify constant used in `TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications` (read it in `codex_appserver_adapter_test.go`) and re-run. Do **not** edit production code.

- [ ] **Step 3: Run the full corpus pattern — expect all green**

Run (work area `packages/agent/daemon`):

```bash
go test ./runtime/ -count=1 -run \
  'TestAppServerCollabAgentFailedCarriesErrorOutput|TestAppServerCollabAgentCompletedCarriesResultOutput|TestAppServerCloseAgentIsControlTool|TestAppServerWaitIsControlTool|TestAppServerForeignThreadMismatch|TestCodexAppServerAdapterExecIgnoresForeignThreadNotifications|TestCodexAppServerAdapterExecStreamsTurn|TestCodexAppServerAdapterSlashCompact|TestCodexAppServerAdapterResumeRetainsReplayedContextUsage|TestCodexAppServerAdapterReleaseLiveSessionClosesClientAndKeepsProviderSession|TestCodexAppServerAdapterReleaseLiveSessionSkipsPendingRequests|TestCodexAppServerAdapterCommandApprovalApprove|TestCodexAppServerAdapterCommandApprovalDecisionMapping|TestCodexAppServerAdapterRequestUserInput|TestAppServerUserInputAnswers'
```

Expected: `ok` — all corpus tests PASS. This is the green baseline every later step must preserve.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/daemon/runtime/codex_appserver_corpus_test.go
git commit -m "test(codex): step0 pin foreign-thread drop semantics (cluster B, changes in step3)"
```

---

## Self-Review

**Spec coverage (Step 0 exit = "a test set, including the bug corpus, that every subsequent step must keep green"):**

- Explicit corpus contract → Task 1 manifest. ✓
- Bug clusters pinned → manifest table maps B/C/D/E to existing tests; A noted as GUI-side/deferred. ✓
- Golden/characterization where thin → Task 2 (collab completed), Task 3 (foreign-thread). ✓ (The whole-turn golden already exists as `...ExecStreamsTurn`, referenced, not duplicated.)
- Pin codex version baseline → Task 1 Step 1–2. ✓
- Green baseline command → Task 1 Step 3, Task 3 Step 3. ✓

**Placeholder scan:** version string is captured via an exact command and written to an exact line (environment data, not a placeholder). Two "if the constant/keys differ, mirror the exact existing test" fallbacks point to specific named tests — grounding guidance, not TODOs.

**Type consistency:** `appServerItemToolCallUpdate(map[string]any, bool) (map[string]any, bool)`, `appServerNotificationThreadMismatch(Session, string, map[string]any) bool`, `asString(any) string`, `acpInt64Value(any) (int64, bool)`, `Session{AgentSessionID, ProviderSessionID string}` — all used consistently with their verified signatures; `<CORPUS_RUN_PATTERN>` is identical in the manifest and Task 3 Step 3.

**Scope note:** Cluster A daemon-half contract is intentionally _not_ authored here (it is Step 4); Step 0 only records that its regression coverage is GUI-side and deferred to Step 9. Steps 1 (codegen) and 2+ each get their own plan.
