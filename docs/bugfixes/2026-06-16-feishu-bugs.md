# 2026-06-16 Feishu Bug Records

## FiklrZfDdePf7ccGtwYcfDOJncc

- Link: https://ccn53rwonxso.feishu.cn/record/FiklrZfDdePf7ccGtwYcfDOJncc
- Record id: unavailable locally; the Base token and table id were not provided, so only the share-token link was available.
- Bug: Task center could surface issue-level execution tasks as normal subtasks after the issue moved out of pending acceptance.
- Log evidence:
  - `runtime-context.json` shows the exported development runtime rooted at `/Users/wwcome/.tutti-dev` with agent sessions included.
  - `export-summary.json` shows the bundle was exported at `2026-06-15T16:28:53.880Z` and included managed logs, app logs, agent sessions, and `app-center-snapshot.json`.
  - `agent-sessions/claude-code/.../2f4e187e.../messages.jsonl` shows issue `issue-c7a876d78677bc446f35324c55cae0d6` initially had `taskCount: 0`, then `tutti-dev issue run create` returned generated task `task-c059d63bf92dc257158b8f6ea85a41ec`, and `issue run complete` attached outputs to that task.
  - `agent-sessions/codex/.../9e0eb2cc.../messages.jsonl` shows breakdown saw an existing subtask `12321` on issue `issue-1d0837d27dd893b521b334c9df0b608d` and updated it into the first breakdown task, confirming that whatever appears in `issueDetail.tasks` is treated as a real child task by downstream workflows.
- Cause: The issue pane hid the issue-level execution task only while the issue was `pending_acceptance`. Once accepted or otherwise no longer pending, the same generated execution task could reappear in the subtask list because `resolveIssueManagerVisibleSubtasks` only filtered the acceptance-task id.
- Fix: Split issue-level run task detection from acceptance-card detection. The acceptance card remains limited to pending acceptance, while the subtask list now filters the latest issue-level run task whenever it matches the issue-level execution-task heuristic.
- Verification:
  - `pnpm --filter @tutti-os/workspace-issue-manager exec tsx --test ./src/ui/internal/issue/IssueManagerIssueAcceptanceState.test.ts`
  - `pnpm --filter @tutti-os/workspace-issue-manager test`
  - `pnpm --filter @tutti-os/workspace-issue-manager typecheck`
- Browser verification: not run; this is Electron task-center state and was verified through the package logic tests that own the display decision.
- Status: fixed locally
- Commit: `7dc986b8`
- Feishu status update: not performed because Base token/table id/status-field configuration was not available in this task input.
