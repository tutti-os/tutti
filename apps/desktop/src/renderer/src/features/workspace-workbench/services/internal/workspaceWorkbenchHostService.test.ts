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
const workspaceWorkbenchRegistrationSource = readFileSync(
  new URL("../registerWorkspaceWorkbenchServices.ts", import.meta.url),
  "utf8"
);
const workspaceWorkbenchShellHookSource = readFileSync(
  new URL("../../ui/useWorkspaceWorkbenchShellRuntime.tsx", import.meta.url),
  "utf8"
);
const workspaceWorkbenchSource = readFileSync(
  new URL("../../ui/WorkspaceWorkbench.tsx", import.meta.url),
  "utf8"
);

test("workspace workbench host keeps deterministic composition and close preparation wiring", () => {
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /resolveWorkbenchCapabilityRegistry\(\s+createTuttiWorkbenchProductProfile\(\{[\s\S]*?workspaceId: input\.workspaceId\s+\}\)\s+\)/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /contributions: contributionRegistry\.contributions/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /prepareHostClose: resolveWorkbenchHostPrepareClose\(\s+contributionRegistry\.contributions\s+\)/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /snapshotRepository: this\.dependencies\.repository/
  );
});

test("workspace workbench host delegates workspace lifecycle to the DI coordinator", () => {
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /this\.hostSessionConfiguration = createWorkbenchHostSessionConfiguration\(\{[\s\S]*?new WorkbenchHostSession<[\s\S]*?>\(\{[\s\S]*?partition,/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /openHostSession\([\s\S]*?configuration: this\.hostSessionConfiguration,[\s\S]*?return createWorkspaceWorkbenchHostSessionBinding\(\{[\s\S]*?bindingId: this\.hostSessionBindingSequence,[\s\S]*?lease,[\s\S]*?workspaceId/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /diagnostics: createDesktopWorkbenchDiagnosticsPort\(\{[\s\S]*?workspaceId: partition\.scope\.id/
  );
  assert.doesNotMatch(workspaceWorkbenchHostServiceSource, /cachedHostInputs/);
  assert.doesNotMatch(workspaceWorkbenchHostServiceSource, /hostSessionLeases/);
  assert.match(
    workspaceWorkbenchRegistrationSource,
    /IWorkbenchHostCoordinator,\s+new SyncDescriptor\(WorkbenchHostCoordinator\)/
  );
  assert.match(
    workspaceWorkbenchShellHookSource,
    /createHostInput: hostSession\.createHostInput/
  );
  assert.match(
    workspaceWorkbenchShellHookSource,
    /hostSession\.attachSurface\(host\)/
  );
  assert.match(
    workspaceWorkbenchSource,
    /useLayoutEffect\(\(\) => \{\s+const binding = workbenchHostService\.openHostSession\(workspaceId\);[\s\S]*?binding\.release\(\)/
  );
  assert.match(workspaceWorkbenchSource, /key=\{hostSession\.bindingId\}/);
});

test("workspace workbench host releases owned wallpaper URLs on disposal", () => {
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /dispose\(\): void \{\s+this\.wallpaperListeners\.clear\(\);\s+this\.clearCustomWallpaperUrls\(\);\s+\}/
  );
});

test("workspace workbench host session resolution keeps stable refs and isolates dynamic dock updates", () => {
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /const cached = current\?\.state/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /cached\.renderFilesNodeBodyRef\.current = input\.renderFilesNodeBody;[\s\S]*?hostInput: this\.createHostInputWithDynamicDockEntries\(/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /const dockSignature = createWorkspaceDynamicDockSignature\(\{[\s\S]*?cached\.dynamicDockSignature === dockSignature[\s\S]*?return cached\.dynamicHostInput/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /cached\.dynamicHostInput = dynamicHostInput;\s+return dynamicHostInput/
  );
  assert.match(
    workspaceWorkbenchHostServiceSource,
    /agentsService: this\.dependencies\.agentsService/
  );
  assert.doesNotMatch(workspaceWorkbenchHostServiceSource, /cached\.agents/);
  assert.doesNotMatch(
    workspaceWorkbenchHostServiceSource,
    /cached\.defaultAgentTargetId/
  );
});

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
