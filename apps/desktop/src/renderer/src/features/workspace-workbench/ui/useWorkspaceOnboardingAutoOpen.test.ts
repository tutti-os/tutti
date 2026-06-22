import assert from "node:assert/strict";
import test from "node:test";
import { openWorkspaceOnboardingIfNeeded } from "./useWorkspaceOnboardingAutoOpen.ts";

test("workspace onboarding auto-open retries when the first open does not launch", async () => {
  let markCalls = 0;
  let openCalls = 0;
  const result = await openWorkspaceOnboardingIfNeeded({
    appCenterService: {
      store: {
        apps: [
          {
            appId: "tutti-onboarding",
            installed: true
          }
        ]
      },
      async refresh() {},
      async refreshCatalog() {},
      async installApp() {},
      async openApp() {
        openCalls += 1;
        return openCalls === 2;
      }
    },
    wait: async () => {},
    workbenchHostService: createWorkbenchHostService({
      markWorkspaceOnboardingAutoOpened: () => {
        markCalls += 1;
      }
    }),
    workspaceId: "workspace-1"
  });

  assert.equal(result, "opened");
  assert.equal(openCalls, 2);
  assert.equal(markCalls, 1);
});

test("workspace onboarding auto-open exhausts retries without marking when the app never opens", async () => {
  let markCalls = 0;
  let openCalls = 0;
  const result = await openWorkspaceOnboardingIfNeeded({
    appCenterService: {
      store: {
        apps: [
          {
            appId: "tutti-onboarding",
            installed: true
          }
        ]
      },
      async refresh() {},
      async refreshCatalog() {},
      async installApp() {},
      async openApp() {
        openCalls += 1;
        return false;
      }
    },
    maxAttempts: 2,
    wait: async () => {},
    workbenchHostService: createWorkbenchHostService({
      markWorkspaceOnboardingAutoOpened: () => {
        markCalls += 1;
      }
    }),
    workspaceId: "workspace-1"
  });

  assert.equal(result, "not-opened");
  assert.equal(openCalls, 2);
  assert.equal(markCalls, 0);
});

test("workspace onboarding auto-open records launch retry diagnostics", async () => {
  let openCalls = 0;
  const diagnostics: WorkspaceOnboardingDiagnostic[] = [];
  const result = await openWorkspaceOnboardingIfNeeded({
    appCenterService: {
      store: {
        apps: [
          {
            appId: "tutti-onboarding",
            installed: true
          }
        ]
      },
      async refresh() {},
      async refreshCatalog() {},
      async installApp() {},
      async openApp() {
        openCalls += 1;
        return openCalls === 2;
      }
    },
    wait: async () => {},
    workbenchHostService: createWorkbenchHostService({
      logWorkspaceOnboardingAutoOpenDiagnostic: (diagnostic) => {
        diagnostics.push(diagnostic);
      }
    }),
    workspaceId: "workspace-1"
  });

  assert.equal(result, "opened");
  assert.deepEqual(
    diagnostics
      .filter((diagnostic) =>
        [
          "workspace-onboarding.auto-open.launch-not-ready",
          "workspace-onboarding.auto-open.opened"
        ].includes(diagnostic.event)
      )
      .map((diagnostic) => ({
        appId: diagnostic.details?.appId,
        attempt: diagnostic.details?.attempt,
        event: diagnostic.event,
        level: diagnostic.level,
        maxAttempts: diagnostic.details?.maxAttempts
      })),
    [
      {
        appId: "tutti-onboarding",
        attempt: 1,
        event: "workspace-onboarding.auto-open.launch-not-ready",
        level: "warn",
        maxAttempts: 20
      },
      {
        appId: "tutti-onboarding",
        attempt: 2,
        event: "workspace-onboarding.auto-open.opened",
        level: "info",
        maxAttempts: 20
      }
    ]
  );
});

type WorkspaceOnboardingDiagnostic = {
  details?: Record<string, unknown>;
  event: string;
  level: "debug" | "info" | "warn" | "error";
  workspaceId: string;
};

function createWorkbenchHostService(input?: {
  logWorkspaceOnboardingAutoOpenDiagnostic?: (
    diagnostic: WorkspaceOnboardingDiagnostic
  ) => void;
  markWorkspaceOnboardingAutoOpened?: () => void;
}) {
  return {
    async hasWorkspaceOnboardingAutoOpened() {
      return false;
    },
    logWorkspaceOnboardingAutoOpenDiagnostic(
      diagnostic: WorkspaceOnboardingDiagnostic
    ) {
      input?.logWorkspaceOnboardingAutoOpenDiagnostic?.(diagnostic);
    },
    async markWorkspaceOnboardingAutoOpened() {
      input?.markWorkspaceOnboardingAutoOpened?.();
    }
  };
}
