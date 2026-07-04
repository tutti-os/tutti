# Codex App-Server Refactor — Bug Corpus (Step 0 Contract)

This is the behavioral safety net for the app-server layer refactor. Every step
(1–9) in `2026-07-01-codex-appserver-refactor-design.md` MUST keep this corpus
green. Where a step replaces a patch with a by-construction fix, the "Will change
in" column names the step allowed to change the test's expectation — any _other_
diff to these tests is a regression.

- Baseline codex version (captured at Step 0): `codex-cli 0.142.5`
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

## Corpus expansion (2026-07-02, refactor + live-testing regressions)

The refactor round proved "all green ≠ bug-free": ten review findings and four
live log-bundle bugs all landed in corpus gaps. Their regression tests are now
part of the contract. Baseline re-check: `codex-cli 0.142.5` (unchanged), source
SHA `6d2168f06ae275d5e1f73cabf935d2bcc8549998` (unchanged) — no drift, no bump.

Run commands (work area `packages/agent/daemon`):

```bash
# runtime additions
go test ./runtime/ -count=1 -run \
  'TestCodexAppServerChildThreadErrorDoesNotFailParentTurn|TestCodexAppServerStrayTurnStartedDoesNotHijackActiveTurn|TestControllerExecSteerSettlesTurnRecordWithoutTerminalEvent|TestCodexAppServerAdapterCancelInterruptsLinkedChildThreads|TestCodexAppServerAdapterCancelAfterTurnCompletedStillMarksChildrenCanceled|TestCodexAppServerAdapterConcurrentStartsLeaveSingleLiveProcess|TestCodexAppServerAdapterStartOverLiveSessionStopsPreviousProcess|TestCodexAppServerAdapterResumeOverLiveSessionClosesPreviousProcess|TestCodexAppServerAdapterResumeSpawnFailureKeepsPreviousSessionLive|TestCodexAppServerAdapterResumeThreadFailureKeepsPreviousSessionLive|TestCodexAppServerAdapterStartReleaseRaceLeavesNoOrphanProcess|TestCodexAppServerClientCloseIsIdempotent|TestCodexAppServerAdapterRoutesLinkedChildThreadEvents|TestCodexAppServerChildThreadNameUpdateEmitsNameMarker|TestCodexAppServerAdapterFetchesChildThreadNickname|TestAppServerCollabAgentRawInputCarriesReceiverThreadIDs|TestCodexAppServerChildRegistrationReportsEarlyDrops|TestReportActivityInputForwardsSubAgentMarkerFieldsToPayload'

# activity store additions (hydration cursor contract)
go test ./activity/ -count=1 -run \
  'TestStoreListSessionMessagesPagesByVersionDespiteOccurredAtOrder|TestStoreSortsSessionMessagesByOccurredAtNotVersion|TestStoreZeroOccurredAtLegacyRowSortsByFallbackTimestamp'
```

| Cluster                          | Added pinning test(s)                                                                                                                                                                                                               | Origin                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **C — turn lifecycle**           | `ChildThreadErrorDoesNotFailParentTurn`, `StrayTurnStartedDoesNotHijackActiveTurn`, `ExecSteerSettlesTurnRecordWithoutTerminalEvent`                                                                                                | review round 2 (branch-introduced regressions)          |
| **B/C — cancel propagation**     | `CancelInterruptsLinkedChildThreads`, `CancelAfterTurnCompletedStillMarksChildrenCanceled`                                                                                                                                          | log bundle 20260702-145427 (`missing turnId` rejection) |
| **D — single live process**      | `ConcurrentStartsLeaveSingleLiveProcess`, `StartOverLiveSession…`, `ResumeOverLiveSession…`, `ResumeSpawnFailure…`, `ResumeThreadFailure…`, `StartReleaseRace…`, `ClientCloseIsIdempotent`                                          | duplicate app-server processes (live)                   |
| **A — hydration cursor**         | `PagesByVersionDespiteOccurredAtOrder`, `SortsSessionMessagesByOccurredAtNotVersion`, `ZeroOccurredAtLegacyRowSortsByFallbackTimestamp`                                                                                             | ADR 0004 + review round 1                               |
| **B — child routing / identity** | `RoutesLinkedChildThreadEvents`, `ChildThreadNameUpdateEmitsNameMarker`, `FetchesChildThreadNickname`, `CollabAgentRawInputCarriesReceiverThreadIDs`, `ChildRegistrationReportsEarlyDrops`, `ForwardsSubAgentMarkerFieldsToPayload` | ADR 0003 + log bundles 153958/165411                    |

Live-gated protocol verification (not part of CI; run manually when protocol
behavior is in question): `TUTTI_LIVE_PROTOCOL_VERIFY=1 go test ./runtime/ -run
TestLiveProtocol -v` — see ADR 0006 "Live verification".
