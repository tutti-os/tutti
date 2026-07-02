import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TuttidProtocolError } from "@tutti-os/client-tuttid-ts";
import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { createWorkspaceWorkbenchDesktopI18nRuntime } from "../../../../../../shared/i18n/index.ts";
import { en } from "../../../../../../shared/i18n/locales/en.ts";
import {
  shouldCloseTerminalNodeAfterCloseFailure,
  shouldCloseTerminalNodeAfterError
} from "./terminalWindowClose.ts";
import {
  createTerminalCloseDialogRequest,
  createWindowCloseDialogRequest
} from "./workspaceCloseDialogRequests.ts";

const workspaceWorkbenchHostServiceSource = readFileSync(
  new URL("./workspaceWorkbenchHostService.ts", import.meta.url),
  "utf8"
);

test("shouldCloseTerminalNodeAfterError closes stale terminal nodes", () => {
  assert.equal(
    shouldCloseTerminalNodeAfterError(
      new TuttidProtocolError({
        code: "workspace_terminal_not_found",
        reason: "workspace_terminal_not_found",
        statusCode: 404
      })
    ),
    true
  );

  assert.equal(
    shouldCloseTerminalNodeAfterError(
      new TuttidProtocolError({
        code: "workspace_terminal_not_running" as never,
        reason: "workspace_terminal_not_running",
        statusCode: 400
      })
    ),
    true
  );
});

test("shouldCloseTerminalNodeAfterError keeps terminal node open for other failures", () => {
  assert.equal(
    shouldCloseTerminalNodeAfterError(new Error("network failed")),
    false
  );
});

test("shouldCloseTerminalNodeAfterCloseFailure closes only ended stale terminals", () => {
  assert.equal(
    shouldCloseTerminalNodeAfterCloseFailure({
      error: new Error("close guard transport failed"),
      status: "detached"
    }),
    false
  );

  assert.equal(
    shouldCloseTerminalNodeAfterCloseFailure({
      error: new Error("terminate failed"),
      status: "failed"
    }),
    true
  );

  assert.equal(
    shouldCloseTerminalNodeAfterCloseFailure({
      error: new Error("network failed"),
      status: "running"
    }),
    false
  );
});

test("createTerminalCloseDialogRequest maps terminal guard into a generic close dialog request", () => {
  const appI18n = createI18nRuntime({
    dictionaries: [
      {
        workspace: {
          workbenchDesktop: en.workspace.workbenchDesktop
        }
      }
    ]
  });
  const desktopI18n = createWorkspaceWorkbenchDesktopI18nRuntime(appI18n);

  const request = createTerminalCloseDialogRequest({
    guard: {
      leaderCommand: "npm run dev",
      reason: "running",
      requiresConfirmation: true,
      status: "running"
    },
    i18n: desktopI18n
  });

  assert.deepEqual(request, {
    cancelLabel: "Cancel",
    confirmLabel: "Terminate terminal",
    description:
      "This terminal still has running work. Terminating it will stop the session.",
    details: "npm run dev",
    scope: "node",
    title: "Terminate terminal?",
    variant: "destructive"
  });
});

test("createWindowCloseDialogRequest summarizes close effects for window close", () => {
  const appI18n = createI18nRuntime({
    dictionaries: [
      {
        workspace: {
          workbenchDesktop: en.workspace.workbenchDesktop
        }
      }
    ]
  });
  const desktopI18n = createWorkspaceWorkbenchDesktopI18nRuntime(appI18n);

  const request = createWindowCloseDialogRequest({
    effects: [
      {
        description: "This terminal still has running work.",
        nodeId: "terminal:1",
        title: "Terminal A",
        typeId: "workspace-terminal"
      }
    ],
    i18n: desktopI18n
  });

  assert.deepEqual(request, {
    cancelLabel: "Keep window open",
    confirmLabel: "Close window",
    description:
      "This window still has running work. Closing it will dismiss the room while background work may continue.",
    details: "Terminal A\nThis terminal still has running work.",
    scope: "window",
    title: "Close this window?",
    variant: "destructive"
  });
});

test("desktop dock preview capture avoids visible window isolation", () => {
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /isForegroundWorkspaceNodeCaptureTarget\(windowElement\)/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /const capturePromise = hostWindowApi\.capturePreview\(\{/
  );
  assert.doesNotMatch(
    workspaceWorkbenchHostServiceSource,
    new RegExp("data-workbench-" + "preview-capture-" + "active")
  );
  assert.doesNotMatch(
    workspaceWorkbenchHostServiceSource,
    new RegExp("captureIsolated" + "WorkspaceWindowPreview")
  );
});

test("workspace app external user project API exposes live project state", () => {
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /getSnapshot: \(\) =>\s+Promise\.resolve\(cloneWorkspaceUserProjectServiceSnapshot\(service\)\)/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /refresh: async \(\) => \{\s+await service\.refresh\(\);\s+return cloneWorkspaceUserProjectServiceSnapshot\(service\);/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /subscribe: \(listener\) =>\s+service\.subscribe\(\(\) => \{\s+listener\(cloneWorkspaceUserProjectServiceSnapshot\(service\)\);/
  );
});

test("workspace app external at query preserves explicit provider filters", () => {
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /input\.query\.providers !== undefined\s+\?\s+input\.query\.providers\s+:\s+tuttiExternalAtProviderIds/
  );
});
