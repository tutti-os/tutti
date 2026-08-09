# Windows title-bar overlay acceptance (2026-08-05)

## Scope

- Worktree: `C:\Work\tutti-os\tutti-windows-thumbnail-titlebar-20260805`
- Branch: `fix/windows-file-thumbnail-native-frame-20260805`
- Runtime state: `.tmp\tutti-windows-p0-p1-flow-e2e`
- Screenshot: `.tmp\tutti-windows-p0-p1-flow-e2e\artifacts\screenshots\15-windows-titlebar-canonical-icon.jpg`

## Scenario flow

1. Restart the Windows Electron dev app from the worktree.
2. Wait for the renderer to load the existing OS-mode workspace with Agent, app-center, and other internal workspace windows.
3. Inspect the real top-level window screenshot and accessibility tree.
4. Verify the custom workspace actions and native Windows caption controls share one row.

## Evidence

- Screenshot shows one top-level row: the `Tutti Dev` mark/title is on the left, custom workspace actions are centered/right, and the native minimize/restore/close controls are on the far right.
- The left mark uses the existing monochrome desktop Tutti icon (`features/app-update/assets/tutti.png`), matching the native window/application icon; it does not use the unrelated flat `TuttiMark` UI glyph.
- Accessibility tree exposes the native controls as `最小化`, `恢复`, and `关闭` before the renderer content, and exposes the custom `帮助`, `快速布局`, `设置`, and `登录` actions in the same window.
- No classic File/Edit menu row is rendered below the title-bar overlay. The application menu remains available through the Alt-key fallback.
- Internal OS-mode workspace windows retain their own in-app window chrome; these are renderer surfaces, not additional Windows native title bars.

## Verification commands

- `workspaceWindowChrome.test.ts`: 2/2 passed
- `applicationMenu.test.ts`: 9/9 passed
- Desktop typecheck: passed
- `electron-vite build`: passed (only existing dynamic-import chunk warnings)
