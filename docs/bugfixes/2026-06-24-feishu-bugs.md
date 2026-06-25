# 2026-06-24 Feishu Bug Records

## Wb7grfq2ZewOJfcB9wucxkHrnvb - app center action label overflow

- Link: https://ccn53rwonxso.feishu.cn/record/Wb7grfq2ZewOJfcB9wucxkHrnvb
- Base record id: `recvnqw6wR47aJ`
- Base: `CEHMbNF8Zavq5wsAO3ecrpQ6nPc`, table `tblieImZwMnvZ8My` (`Bug 管理`)
- Bug: 应用中心卡片右上角的主操作文案在版本号较长时超出卡片边界。
- Evidence: `image.png` from Feishu attachment `EMgVbwMC4ozXBmxa6EpchvyLnWb` shows labels such as `可更新到 0.0.20+78abd4a...` overflowing from the first app card into the next card.
- Cause: `AppCard` rendered the top-right action group as `shrink-0`, and the primary action button used an unconstrained width. Long update labels could force the action group wider than the card instead of truncating.
- Fix: Allow the action group to shrink within the card header, constrain the primary action button with `min-w-0 max-w-full`, truncate long labels, and keep the full label in the button title.
- Verification:
  - `pnpm --filter @tutti-os/workspace-app-center test`
  - `pnpm --filter @tutti-os/workspace-app-center typecheck`
- Status: fixed locally
- Commit: this commit
- Feishu status update: pending after commit and verification.

## Wb7grfq2ZewOJfcB9wucxkHrnvb - pending restart dock entry

- Link: https://ccn53rwonxso.feishu.cn/record/Wb7grfq2ZewOJfcB9wucxkHrnvb
- Record id: unavailable locally; the short `/record/...` link does not expose Base token/table id, no local bug-runner config was present, and the managed browser redirected to Feishu login.
- Bug: After a workspace app update/download, the dock entry could become disabled even though the app should remain actionable through restart-and-open.
- Evidence: `/Users/wwcome/Downloads/tutti-logs-20260624-204049.zip` shows `ai-doc` in `installed_pending_restart` with `enabled=true`, `installed=true`, `launchUrl=http://127.0.0.1:53807`, `version=0.1.16`, and `availableVersion=0.1.18`. The logs also repeatedly show `workspace app updated event publish failed` with `app.status is unsupported`.
- Cause: The desktop dock projection only treated `running` workspace apps as launch-enabled, so `installed_pending_restart` fell through to disabled. Separately, eventstream's hand-written workspace app status validator did not allow the schema/API-supported `installed_pending_restart` status, blocking update events for that state.
- Fix: Mark `installed_pending_restart` workspace apps as dock-launchable, route dock clicks for that state through the existing `restartAndOpenApp` flow, and allow `installed_pending_restart` in eventstream validation.
- Verification:
  - `node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types ./apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterContribution.test.ts ./apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterDockProjection.test.ts`
  - `pnpm --filter @tutti-os/workspace-app-center test`
  - `go test ./services/tuttid/service/eventstream`
  - `pnpm --filter @tutti-os/desktop typecheck`
- Status: fixed locally
- Commit: this commit
- Feishu status update: not performed because the short record link could not be resolved to a writable Base record without Base token/table id or an authenticated browser session.
