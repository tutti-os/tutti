# 2026-06-13 Feishu Bug Records

## recvmjdXdEm0Q9

- Link: https://ccn53rwonxso.feishu.cn/record/TDHQrHSGye91JechPozcOBB7nVb
- Bug: 事项中心子任务侧边栏缺少明确的返回入口，用户容易误点窗口右上角关闭整个应用。
- Cause: The task drawer could only be dismissed through the backdrop; its header title area had no explicit close/back control.
- Fix: Added an accessible icon-only back button before the task drawer title, wired it to the drawer `onClose` handler, and added localized labels.
- Verification:
  - `node --test --experimental-strip-types packages/workspace/issue-manager/src/ui/internal/shell/IssueManagerTaskDrawerState.test.ts`
  - `pnpm --filter @tutti-os/workspace-issue-manager typecheck`
  - `pnpm --filter @tutti-os/workspace-issue-manager test`
  - `pnpm check:i18n`
  - `pnpm lint:ts`
  - `pnpm typecheck`
  - `pnpm --filter @tutti-os/desktop build`
- Browser verification: blocked because this issue is inside the Electron workspace task center and requires local app/runtime state rather than a browser-served route; verified by package tests, full TS checks, i18n, lint, and desktop production build.
- Status: fixed
- Commit: `79350fa0`
