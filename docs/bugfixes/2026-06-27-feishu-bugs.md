# 2026-06-27 Feishu Bug Records

## O0wTrJF9BerYUKc14OUchDIVnJf - workspace-reference mention routing

- Link: https://ccn53rwonxso.feishu.cn/record/O0wTrJF9BerYUKc14OUchDIVnJf
- Base record id: unresolved locally; the short record link does not include Base/table ids, Chrome MCP timed out, and unauthenticated curl reached only the Feishu login page.
- Bug: `workspace-reference` mention cannot be recognized by the agent.
- Evidence: Runtime policy already routes `mention://workspace-reference/<id>?source=...&workspaceId=...` to the `reference` skill, but Claude Code ACP's injected first-tool-call routing only mapped `workspace-issue`, `workspace-app`, and `agent-session`.
- Cause: `skillForMentionURI` missed the `mention://workspace-reference/` prefix, so Claude Code did not receive the stronger `Skill(skill="reference", args="<mention>")` instruction for this mention kind.
- Fix: Map `workspace-reference` mentions to the `reference` skill in Claude Code ACP mention routing and add a regression test.
- Verification:
  - `gofmt -w packages/agent/daemon/runtime/standard_acp_adapter.go packages/agent/daemon/runtime/standard_acp_adapter_test.go`
  - `go test ./packages/agent/daemon/runtime -run 'TestClaudeCodeAdapterExec(PrependsMentionRoutingDirective|RoutesWorkspaceReferenceMention)'`
- Status: fixed locally
- Commit: pending
- Feishu status update: not updated; real Base record id could not be resolved from the supplied short link.

## NFCyrr5Z8eVe02c7uNDcKVKrnog - workspace app update reopens stale Vibe Design

- Link: https://ccn53rwonxso.feishu.cn/record/NFCyrr5Z8eVe02c7uNDcKVKrnog
- Base record id: `recvmCg08QQojR`
- Bug: 点击更新按钮后，关掉 Vibe Design 后再打开没有获取到最新版本，需要重启 Tutti 才能看到最新功能改动。
- Evidence: The Base record has no downloadable log zip; it includes recording attachment `录屏2026-06-15 20.44.23.mov`. Code inspection showed `installed_pending_restart` apps can still have a matching `workspace-app-webview` dock node, and workbench dock single-instance clicks focus that node before launch resolution.
- Cause: The dock entry for a pending-restart workspace app still used the default single-instance focus behavior. When a stale app webview node still matched the dock entry, dock clicks bypassed `resolveWorkspaceAppCenterLaunchRequest`, so `restartAndOpenApp` did not close the old view and restart/open the updated package.
- Fix: Pending-restart workspace app dock entries now force dock clicks through the normal launch request path. The existing launch resolver then calls `restartAndOpenApp`; normal running apps keep the regular focus behavior.
- Verification:
  - `node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types ./apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterContribution.test.ts`
  - `node --test --experimental-strip-types packages/workbench/surface/src/host/dockEntries.test.ts`
- Status: fixed locally
- Commit: pending
- Feishu status update: not updated.

## Untracked - workspace app update confirmation shown for unopened app

- Bug: App Center showed the strong update confirmation for a running workspace app even when no workbench app window was currently open.
- Evidence: The shared App Center panel gated the confirmation on `app.installed && app.status === "running"`, which reflects runtime process state rather than whether a `workspace-app-webview` node is open in the workspace.
- Cause: Runtime state and visible/open workbench state were conflated. A background running runtime can be updated without interrupting an open app window, so it should not require the restart warning prompt.
- Fix: Desktop now provides App Center with a real-time workbench webview-open check from the current `WorkbenchHost` snapshot. The update confirmation appears only when the app runtime is running and its workspace app webview is currently open; unopened running apps go directly into the update flow.
- Verification:
  - `node --import ./test/register-asset-stub.mjs --test --experimental-strip-types ./src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterService.test.ts` from `apps/desktop`
  - `pnpm lint:ts`
  - `pnpm typecheck`
  - `pnpm check:changed --tail-lines 120`
- Maintenance note: The former `packages/workspace/app-center/src/ui/AppCenterPanel.source.test.ts` source-regex check was removed in the later low-value test cleanup because it only matched implementation strings.
- Status: fixed locally
- Commit: pending
