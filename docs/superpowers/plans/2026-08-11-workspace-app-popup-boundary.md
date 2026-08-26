# Workspace App Popup Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Workspace App popup routing one main-process policy owner, keep it fail closed, preserve the published guest-attachment API, expose unsupported popup modes to users, and prove one real external popup maps to one Workbench Browser surface.

**Architecture:** The Browser Node Electron package installs one stable deny-first delegate before host code and gives new hosts a separate attachment resolver while retaining the legacy callback. Desktop main owns internal-versus-external popup policy and private rejection IPC; preload keeps only explicit bridges. A real Electron renderer fixture runs the production Browser service, launch coordinator, presenter, and Workbench host to count the complete chain.

**Tech Stack:** TypeScript, Electron 43, Node test runner, React 19, Vite, `@tutti-os/browser-node`, `@tutti-os/workbench-surface`, Desktop typed IPC and i18n.

## Global Constraints

- Popup correctness comes from one Electron policy owner, never preload interception, renderer dedupe state, or operation IDs.
- Every real popup request remains independent because `reuseIfOpen: false` is intentional.
- Native Electron child windows remain denied for Workspace Apps.
- POST bodies are never transported, persisted, logged, or replayed as GET.
- Published `onGuestAttached` consumers keep their previous handler-override behavior.
- User-visible copy uses Desktop i18n; Simplified Chinese copy does not end with `。`.
- Production and Electron fixture composition use the same Desktop installer.

---

### Task 0: Synchronize the current PR branch

**Files:**
- Inspect: every file changed by the upstream merge

**Interfaces:**
- Consumes: current `upstream/main`.
- Produces: a conflict-free PR branch whose merge base includes the latest main.

- [x] **Step 1: Fetch and inspect divergence**

Run `git fetch upstream main`, then inspect `git rev-list --left-right --count
HEAD...upstream/main` and the upstream diff for every file already touched by
this PR.

- [x] **Step 2: Merge upstream main without automatic conflict shortcuts**

Run `git merge --no-edit upstream/main`. Resolve any conflict by preserving both
branch intents; never use `--ours` or `--theirs` for source files.

- [x] **Step 3: Verify the synchronized baseline**

Run `git diff --name-only --diff-filter=U` and require empty output. Re-run the
47 focused package, Desktop, and real Electron popup baseline tests before Task
1 changes behavior.

---

### Task 1: Fail-closed package router and public-hook compatibility

**Files:**
- Modify: `packages/browser/workbench-node/src/electron-main/webviewSecurity.ts`
- Modify: `packages/browser/workbench-node/src/electron-main/electronMain.test.ts`
- Modify: `packages/browser/workbench-node/src/electron-main/index.ts`

**Interfaces:**
- Consumes: `installBrowserGuestWindowOpenRouter({ contents, fallbackHandler, hostHandler? })`.
- Produces: `resolveGuestAttachment?: (guestContents, input) => BrowserWebviewGuestAttachment | undefined` on `InstallBrowserWebviewSecurityInput`.
- Preserves: `onGuestAttached?: (guestContents: WebContents) => void`.

- [x] **Step 1: Add the failing fail-closed regression**

Add a Node test that emits a valid `will-attach-webview`, makes
`resolveGuestAttachment` throw, captures the installed window-open handler, and
asserts the setter was called once and the captured handler returns
`{ action: "deny" }` without calling `openExternal`.

```ts
test("keeps Browser guests fail closed when host attachment setup throws", () => {
  const installed: BrowserWebviewWindowOpenHandler[] = [];
  const warnings: string[] = [];
  // The existing EventEmitter test helper emits will-attach and did-attach.
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0]?.(createWindowOpenDetails()), {
    action: "deny"
  });
  assert.deepEqual(warnings, ["Browser Node webview guest setup failed"]);
});
```

- [x] **Step 2: Run the package test and verify RED**

Run:

```bash
node --test --experimental-strip-types packages/browser/workbench-node/src/electron-main/electronMain.test.ts
```

Expected: FAIL because `resolveGuestAttachment` is not accepted and the host
exception currently happens before any handler installation.

- [x] **Step 3: Add the failing legacy-override regression**

Restore the published behavior test: `onGuestAttached` directly calls
`guestContents.setWindowOpenHandler(legacyHandler)`, then a popup must invoke
the legacy handler rather than the package fallback. Assert two setter calls:
the package default first and the legacy host override second.

- [x] **Step 4: Run the package test and verify the compatibility test is RED**

Run the same Node test command. Expected: FAIL because the current package
installs its router after `onGuestAttached` and overwrites the legacy handler.

- [x] **Step 5: Implement the minimal API split and deny-first order**

Change the input shape and `did-attach-webview` order:

```ts
export interface InstallBrowserWebviewSecurityInput {
  onGuestAttached?: (guestContents: WebContents) => void;
  resolveGuestAttachment?: (
    guestContents: WebContents,
    input: BrowserWebviewGuestAttachedInput
  ) => BrowserWebviewGuestAttachment | undefined;
  // Existing fields stay unchanged.
}
```

In `handleDidAttachWebview`, install a deny fallback before user-agent or host
code. In a `try` block, apply the user agent, resolve the new attachment, update
the stable router with the externalizing fallback and host route, then invoke
the legacy callback last. Catch setup errors and log
`Browser Node webview guest setup failed`; do not remove or replace the initial
deny delegate.

- [x] **Step 6: Run the package regression suite and verify GREEN**

Run the Task 1 Node command. Expected: all package Electron-main tests pass,
including setter cardinality and the legacy override.

- [x] **Step 7: Commit Task 1**

```bash
git add packages/browser/workbench-node/src/electron-main/webviewSecurity.ts packages/browser/workbench-node/src/electron-main/electronMain.test.ts packages/browser/workbench-node/src/electron-main/index.ts
git commit -s -m "fix(browser-node): fail closed during guest attachment"
```

### Task 2: Reuse Desktop production webview composition

**Files:**
- Create: `apps/desktop/src/main/windows/workspaceWebviewSecurity.ts`
- Create: `apps/desktop/src/main/windows/workspaceWebviewSecurity.test.ts`
- Modify: `apps/desktop/src/main/windows/workspaceWindow.ts`
- Modify: `apps/desktop/src/main/ipc/workspaceAppPopup.electron.fixture.ts`

**Interfaces:**
- Consumes: Task 1 `resolveGuestAttachment` hook.
- Produces: `installWorkspaceWindowWebviewSecurity(input): () => void`.
- Owns: Workspace App partition allowance, both guest registries, preload selection, Tutti asset-protocol registration, and external popup fallback.

- [x] **Step 1: Write the failing production-composition test**

Create a focused test with injected registration and preload dependencies. Emit
a Workspace App attach and assert exactly one Browser guest registration, one
Workspace App registration, the Workspace App preload path, and one returned
host attachment route. Emit an ordinary Browser attach and assert only Browser
registration and the Browser preload path.

- [x] **Step 2: Run the composition test and verify RED**

```bash
node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types apps/desktop/src/main/windows/workspaceWebviewSecurity.test.ts
```

Expected: FAIL because the shared Desktop installer does not exist.

- [x] **Step 3: Extract the production installer**

Create `installWorkspaceWindowWebviewSecurity` with explicit injectable runtime
dependencies defaulting to the real Electron/session/registry functions. It
calls `installBrowserWebviewSecurity` with:

```ts
{
  allowedSessionPartitions: {
    additionalAllowedPrefixes: [workspaceAppBrowserPartitionPrefix]
  },
  resolveGuestAttachment(guestContents, { params }) {
    registerBrowserGuest(ownerWindow, guestContents, logger);
    return isWorkspaceAppSessionPartition(params.partition)
      ? registerWorkspaceAppGuest(
          ownerWindow,
          guestContents,
          logger,
          params.partition
        )
      : undefined;
  }
}
```

Move the existing preload selection into this installer unchanged.

- [x] **Step 4: Replace manual production and fixture wiring**

`workspaceWindow.ts` calls the new installer. The real Electron fixture calls
the same installer with its test preload path and logger; remove its direct
`installBrowserWebviewSecurity` and `createWorkspaceAppWindowOpenHandler`
composition.

- [x] **Step 5: Run unit and real Electron tests and verify GREEN**

```bash
node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types apps/desktop/src/main/windows/workspaceWebviewSecurity.test.ts
node --import ./apps/desktop/test/register-asset-stub.mjs --test --experimental-strip-types apps/desktop/src/main/ipc/workspaceAppPopup.electron.test.ts
```

Expected: both pass and the fixture still reports zero native child windows.

- [x] **Step 6: Commit Task 2**

```bash
git add apps/desktop/src/main/windows/workspaceWebviewSecurity.ts apps/desktop/src/main/windows/workspaceWebviewSecurity.test.ts apps/desktop/src/main/windows/workspaceWindow.ts apps/desktop/src/main/ipc/workspaceAppPopup.electron.fixture.ts
git commit -s -m "refactor(desktop): share workspace webview composition"
```

### Task 3: Localized unsupported-POST rejection

**Files:**
- Modify: `apps/desktop/src/shared/contracts/ipc.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/preload/api/browser.ts`
- Modify: `apps/desktop/src/main/ipc/workspaceAppWindowOpen.ts`
- Modify: `apps/desktop/src/main/ipc/workspaceAppWindowOpen.test.ts`
- Create: `apps/desktop/src/renderer/src/app/windows/workspace/workspaceAppPopupNotifications.ts`
- Create: `apps/desktop/src/renderer/src/app/windows/workspace/workspaceAppPopupNotifications.test.ts`
- Modify: `apps/desktop/src/renderer/src/app/windows/workspace/createWorkspaceWindowContainer.ts`
- Modify: `apps/desktop/src/shared/i18n/locales/en.ts`
- Modify: `apps/desktop/src/shared/i18n/locales/zh-CN.ts`

**Interfaces:**
- Produces: `DesktopWorkspaceAppPopupRejectedEvent = { reason: "post-unsupported" }`.
- Produces: `DesktopBrowserApi.onWorkspaceAppPopupRejected(listener): () => void`.
- Produces: `registerWorkspaceAppPopupNotifications({ browserApi, notifications, translate }): () => void`.

- [x] **Step 1: Extend the existing POST handler test and verify RED**

Assert the owner receives one message on
`desktopIpcChannels.browser.workspaceAppPopupRejected` with only:

```ts
{ reason: "post-unsupported" }
```

Keep the Browser open-URL event array empty and assert the request body bytes
never appear in the payload or logs.

- [x] **Step 2: Add the renderer notification test and verify RED**

Register the wished-for notification binding against a fake typed subscription,
emit `{ reason: "post-unsupported" }`, and assert one error notification uses:

```ts
{
  title: "This app cannot open the authorization popup",
  description:
    "POST-based popups are not supported. Try another sign-in method or contact the app provider."
}
```

Run both exact test files and confirm failure because the event and binding do
not exist.

- [x] **Step 3: Implement the private IPC and preload subscription**

Add the channel and shared payload type. In the main handler, send only the
reason code before returning `{ action: "deny" }`. Add the preload subscription
with `ipcRenderer.on/removeListener`; exclude this send-only channel from the
generic Browser invoke-channel union.

- [x] **Step 4: Implement and compose localized notification binding**

Add English and Simplified Chinese resources:

```ts
workspaceAppPopup: {
  postUnsupportedDescription:
    "POST-based popups are not supported. Try another sign-in method or contact the app provider.",
  postUnsupportedTitle: "This app cannot open the authorization popup"
}
```

```ts
workspaceAppPopup: {
  postUnsupportedDescription:
    "暂不支持通过 POST 打开的弹窗，请尝试其他登录方式或联系应用提供方",
  postUnsupportedTitle: "这个应用无法打开授权弹窗"
}
```

Register the binding after creating the workspace notification service and
dispose it with the window container.

- [x] **Step 5: Run focused POST, preload, notification, and i18n checks**

Run the exact tests, `pnpm check:i18n`, and the Desktop preload typecheck lane.
Expected: POST produces no Browser event, the private event contains no body,
and the localized notification appears once.

- [x] **Step 6: Commit Task 3**

```bash
git add apps/desktop/src/shared/contracts/ipc.ts apps/desktop/src/preload/types.ts apps/desktop/src/preload/api/browser.ts apps/desktop/src/main/ipc/workspaceAppWindowOpen.ts apps/desktop/src/main/ipc/workspaceAppWindowOpen.test.ts apps/desktop/src/renderer/src/app/windows/workspace/workspaceAppPopupNotifications.ts apps/desktop/src/renderer/src/app/windows/workspace/workspaceAppPopupNotifications.test.ts apps/desktop/src/renderer/src/app/windows/workspace/createWorkspaceWindowContainer.ts apps/desktop/src/shared/i18n/locales/en.ts apps/desktop/src/shared/i18n/locales/zh-CN.ts
git commit -s -m "fix(desktop): surface unsupported workspace popup posts"
```

### Task 4: Real Electron callback-to-surface cardinality chain

**Files:**
- Create: `apps/desktop/test/fixtures/workspaceAppPopupRenderer.electron.fixture.tsx`
- Modify: `apps/desktop/src/main/ipc/workspaceAppPopup.electron.fixture.ts`
- Modify: `apps/desktop/src/main/ipc/workspaceAppPopup.electron.test.ts`
- Modify: `apps/desktop/src/main/ipc/workspaceAppWindowOpen.ts`

**Interfaces:**
- Consumes: production Desktop installer from Task 2 and private rejection subscription from Task 3.
- Consumes: `createWorkspaceBrowserService`, `registerWorkspaceBrowserLaunchHandler`, `createWorkbenchWorkspaceBrowserPresenter`, and public `WorkbenchHost`.
- Produces fixture observations: `producerCallbacks`, `browserEvents`, `workbenchLaunches`, `browserSurfaces`, `rejectionNotifications`, and `nativeChildWindows`.

- [x] **Step 1: Expand fixture assertions and verify RED**

Add `workbenchLaunches`, `browserSurfaces`, and `rejectionNotifications` to
every case. Add a `double-window-open` case that executes two real
`window.open()` calls in one browser action and expects `2/2/2/2`. The POST
case expects `1 callback, 0 event, 0 launch, 0 surface, 1 notification, 0 native
child`.

- [x] **Step 2: Run the real Electron test and verify RED**

Run the exact Electron test outside the filesystem sandbox. Expected: FAIL
because the fixture does not yet report downstream cardinalities.

- [x] **Step 3: Build the real renderer chain**

Create a Vite-built renderer entry that:

- renders public `WorkbenchHost` with an initialized empty snapshot and a real
  multi-instance Browser node definition plus the production Browser launch
  handler;
- wires raw Electron Browser events into the real workspace Browser service;
- registers the real launch coordinator and presenter against the Workbench
  handle;
- counts calls around the real `host.launchNode` while reading final Browser
  surface count from `host.getSnapshot()`;
- uses Task 3's production notification binding with a recording notification
  service;
- sends cumulative observations to the fixture only after the snapshot reaches
  the expected surface count.

- [x] **Step 4: Replace timeout observation with condition-based acknowledgments**

Build the renderer bundle beside the Workspace App preload, pass its path to
Electron, and require it from the owner window. Count producer callbacks from a
new debug log at the first line of the real Workspace App handler. For every
case, wait for the renderer observation matching the expected event or rejection
count; do not use a fixed 300 ms POST sleep.

- [x] **Step 5: Run the real Electron test and verify GREEN**

Expected cumulative result: one real request maps to one callback/event/launch/
surface, two real requests map to two of each, POST maps to one callback and one
visible rejection only, and native child windows stay zero.

- [x] **Step 6: Commit Task 4**

```bash
git add apps/desktop/test/fixtures/workspaceAppPopupRenderer.electron.fixture.tsx apps/desktop/src/main/ipc/workspaceAppPopup.electron.fixture.ts apps/desktop/src/main/ipc/workspaceAppPopup.electron.test.ts apps/desktop/src/main/ipc/workspaceAppWindowOpen.ts
git commit -s -m "test(desktop): trace workspace popups to browser surfaces"
```

### Task 5: Durable documentation and final validation

**Files:**
- Modify: `docs/architecture/browser-node-package.md`
- Modify: `docs/conventions/troubleshooting/toolchain-browser-terminal.md`
- Modify: `docs/superpowers/plans/2026-08-11-workspace-app-popup-boundary.md`

**Interfaces:**
- Documents the final public hook split, fail-closed order, private POST UX, and
  `callback -> event -> launch -> surface` diagnostic formula.

- [x] **Step 1: Update durable docs**

Record that the stable router is installed before host code, legacy
`onGuestAttached` remains an override hook, new hosts use
`resolveGuestAttachment`, unsupported POST attempts are denied with localized
feedback, and the Electron regression asserts both `1/1/1/1` and `2/2/2/2`.

- [x] **Step 2: Mark every completed plan checkbox**

Update this file from `- [ ]` to `- [x]` only for steps backed by command
output or committed source.

- [x] **Step 3: Inspect the changed-aware validation plan**

```bash
pnpm check:changed -- --base upstream/main --push-ready --dry-run
```

Confirm it selects Browser Node, Desktop tests/typechecks, Electron runtime
boundaries, i18n, build, lint, format, and package validation.

- [x] **Step 4: Run final validation once**

```bash
pnpm check:changed -- --base upstream/main --push-ready
```

If the dry-run omits the real Electron test, run that exact test separately
outside the sandbox. Use `--failed-only` after any code fix rather than rerunning
already-passing unchanged lanes.

The aggregate command was attempted with the repository-pinned package-manager
version. Its Corepack child lanes could not verify the pnpm registry signature
without network access, so every selected lane was rerun through its installed
Node or local binary entry. The real Electron chain was also rerun outside the
filesystem sandbox.

- [x] **Step 5: Commit documentation and plan evidence**

```bash
git add docs/architecture/browser-node-package.md docs/conventions/troubleshooting/toolchain-browser-terminal.md
git add -f docs/superpowers/plans/2026-08-11-workspace-app-popup-boundary.md
git commit -s -m "docs(desktop): record workspace popup ownership"
```

- [ ] **Step 6: Push and verify the ready PR**

Push the existing branch, then read back the PR draft state, Chinese title and
description, head commit, mergeability, and CI status. Report the
external approval gate separately from code validation.

### Task 6: Main-owned internal and external popup policy

**Files:**
- Modify: `apps/desktop/src/main/ipc/workspaceAppWindowOpen.ts`
- Delete: `apps/desktop/src/preload/entries/workspaceAppLinks.ts`
- Delete: `apps/desktop/src/preload/entries/workspaceAppLinks.test.ts`
- Modify: popup unit, notification, and real Electron fixture tests
- Modify: Desktop popup i18n and durable popup documentation

**Interfaces:**
- Internal HTTP(S) target with the current guest origin: schedule current-guest
  navigation after returning `deny`; emit no Browser event.
- External HTTP(S) target: emit one Browser event and return `deny`.
- Empty or `about:blank` target: reject with
  `deferred-navigation-unsupported` and localized feedback.
- POST target: preserve the existing fail-closed rejection and never replay the
  body as GET.

- [x] **Step 1: Prove the old owner boundary fails**

Add a main-handler test requiring same-origin navigation and zero Browser
events. Run it on the old implementation and retain the failing assertion as
negative-control evidence.

- [x] **Step 2: Move policy ownership to main**

Compare the accepted popup target with `guestContents.getURL()`, schedule
`loadURL` only after the handler returns, and keep external events independent.
Remove the preload click listener and both isolated/main-world `window.open`
patches.

- [x] **Step 3: Make compatibility boundaries explicit**

Reject deferred `about:blank` popups with localized feedback. Document that
native-child denial makes `window.open()` return `null`; managed deferred OAuth
is a separate future contract. Preserve explicit Tutti browser APIs.

- [x] **Step 4: Extend real Electron evidence**

Cover internal blank-link and `window.open` navigation with zero Browser
surfaces, external cardinality, deferred rejection, POST rejection, returned
`WindowProxy` semantics, and zero native child windows.

- [ ] **Step 5: Run final changed-aware validation and deliver the PR**

Run the selected repository lanes, commit with DCO sign-off, push the existing
PR branch, update its Chinese title/body, and re-read approval plus CI state.
