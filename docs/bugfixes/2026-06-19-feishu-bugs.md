# 2026-06-19 Feishu Bug Records

## RYrmrMCt7eVFp2cutTBcntOLn5b

- Link: https://ccn53rwonxso.feishu.cn/record/RYrmrMCt7eVFp2cutTBcntOLn5b
- Base record id: `recvmXpMTyS6mk`
- Bug: `@` panel application category showed Agent app entries that were not currently available, such as uninstalled/unbound Claude Code.
- Evidence: The screenshot showed the composer `@` application panel listing App Center apps together with `Claude Code` and `Codex`. The existing implementation built `workspace-app` mention entries directly from CLI capabilities, while only App Center-sourced entries were filtered by installed/enabled app state.
- Cause: Agent-backed app capability entries (`agent-claude-code`, `agent-codex`) bypassed the Agent provider availability snapshot, so unavailable Agent providers could still appear in the app mention panel.
- Fix: Thread the desktop Agent provider status service into rich-text `@` provider construction. Known Agent app IDs are now kept only when the corresponding provider is `ready` after the provider status snapshot has loaded; pre-load behavior remains unchanged to avoid hiding all Agent entries before detection finishes.
- Verification:
  - `node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types ./apps/desktop/src/renderer/src/features/rich-text-at/services/internal/desktopRichTextAtService.test.ts`
  - `pnpm --filter @tutti-os/desktop typecheck` failed only on pre-existing `listWorkspaceAgentGeneratedFiles` mock/client mismatch errors outside this fix.
- Status: fixed locally
- Commit: this commit
- Feishu status update: set to `已修复待打包` with fix notes.

## HI7lrOFMVeKRjKcgK22cKs1dnGf

- Link: https://ccn53rwonxso.feishu.cn/record/HI7lrOFMVeKRjKcgK22cKs1dnGf
- Base record id: `recvmTP6qDB2SN`
- Bug: After installing a new package, Claude Code still showed as needing installation, and clicking install appeared to remain in progress.
- Log evidence: `tutti-logs-20260618-204709.zip` contains repeated `npm error code ENOENT` / `npm error syscall lstat` for `/Users/Sun/.tutti/agent-providers/external-agent-registry/packages`, followed by `ENOENT: no such file or directory`.
- Cause: External registry NPM provider command resolution could produce an `npm --prefix ... exec` command before the external registry package prefix directory existed. On older installs or fresh registry cache roots, npm failed while lstat-ing the missing parent path, preventing the configured provider runtime from becoming available.
- Fix: Ensure the external registry NPM prefix directory exists while resolving the provider spec, before returning the managed-runtime npm command.
- Verification:
  - `go test ./service/agentstatus`
  - `go test ./...`
  - `go build ./...`
- Status: fixed locally
- Commit: this commit
- Feishu status update: set to `已修复待打包` with fix notes.

## NOAUrbbqEeWz2icEsdkctXY9n7W

- Link: https://ccn53rwonxso.feishu.cn/record/NOAUrbbqEeWz2icEsdkctXY9n7W
- Base record id: `recvmY89ypTdxP`
- Bug: On Mac Intel, Claude Code and Codex could not be installed or opened from Agent GUI.
- Log evidence: `tutti-logs-20260619-143353.zip` shows a dock click for `agent-gui` resolving to `{"kind":"blocked"}` with `dockNodeState:"closed"` and no matching open nodes.
- Cause: Default Agent GUI dock entries stayed visible while `not_installed` or `auth_required`, but their dock state was `disabled`. Workbench dock click resolution blocks disabled entries before launching the Agent GUI panel, so users could not reach the setup surface that exposes install/login actions.
- Fix: Keep default Agent GUI providers (`Codex`, `Claude Code`) visible with their setup hover actions, but project `not_installed` and `auth_required` default-provider dock states as launchable so the Agent GUI setup panel can open.
- Verification:
  - `node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types ./apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceAgentProviderDockStateSource.test.ts`
  - `pnpm --filter @tutti-os/desktop typecheck`
- Status: fixed locally
- Commit: `55d04f80`
- Feishu status update: set to `已修复待打包`.
