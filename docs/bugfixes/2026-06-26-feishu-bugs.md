# 2026-06-26 Feishu Bug Records

## Avz6rluJkenUiBclttvcETu9nNb - user prompt image/text spacing

- Link: https://ccn53rwonxso.feishu.cn/record/Avz6rluJkenUiBclttvcETu9nNb
- Base record id: `recvmIdLrHJPZm`
- Bug: 复制图片到输入框，和文字一起发送后，会话详情里图片和文字间隔较远。
- Evidence: Feishu attachment `image.png` shows a narrow screenshot preview above the user text bubble with a large visual gap before the text.
- Cause: User prompt image thumbnails were rendered inside a fixed 80px square preview. Wide clipboard screenshots could make the preview area read as empty spacing before the following text bubble.
- Fix: Render single user prompt images as proportional thumbnails with a 160px column and 80px max height, while keeping multi-image grids compact at 80px columns.
- Verification:
  - `corepack pnpm --dir packages/agent/gui exec vitest run --environment jsdom shared/agentConversation/components/AgentTranscriptItemView.spec.tsx`
  - `corepack pnpm --filter @tutti-os/agent-gui typecheck`
  - Web check: opened `http://127.0.0.1:5173/`; page rendered Agent GUI without framework overlay. Current local workspace had no user image message to reproduce visually.
- Status: fixed locally
- Commit: `40cb83d1`
- Feishu status update: confirmed `已修复待打包`.

## QZHZrXdLje5vLNcl0o5c7J61ndb - agent link opens new browser node

- Link: https://ccn53rwonxso.feishu.cn/record/QZHZrXdLje5vLNcl0o5c7J61ndb
- Base record id: `recvngl9SFXOxy`
- Bug: 打开浏览器后再在会话里点击网页链接，会覆盖之前打开的浏览器窗口。
- Evidence: Feishu screen recording shows an existing browser node on Google search, then a conversation URL click navigates that same browser node to the new URL.
- Cause: Agent GUI `open-url` actions used the default workspace browser launch behavior, which reuses the current browser node when one exists.
- Fix: Pass `reuseIfOpen: false` for Agent GUI URL actions so conversation links launch a fresh browser node instead of replacing the current one.
- Verification:
  - `node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types ./apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentGUILinkActions.test.ts`
  - `corepack pnpm --filter @tutti-os/desktop typecheck`
  - Web check: opened `http://127.0.0.1:5173/`; page rendered Agent GUI. Existing local conversation link clicks were blocked by the current virtualized transcript/preview layer, so the browser-node behavior was verified by the targeted link action test.
- Status: fixed locally
- Commit: pending; final hash recorded in batch summary.
- Feishu status update: confirmed `已修复待打包`.
