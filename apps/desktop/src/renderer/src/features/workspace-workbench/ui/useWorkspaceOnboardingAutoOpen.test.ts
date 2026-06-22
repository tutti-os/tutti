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
    workbenchHostService: {
      async hasWorkspaceOnboardingAutoOpened() {
        return false;
      },
      async markWorkspaceOnboardingAutoOpened() {
        markCalls += 1;
      }
    },
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
    workbenchHostService: {
      async hasWorkspaceOnboardingAutoOpened() {
        return false;
      },
      async markWorkspaceOnboardingAutoOpened() {
        markCalls += 1;
      }
    },
    workspaceId: "workspace-1"
  });

  assert.equal(result, "not-opened");
  assert.equal(openCalls, 2);
  assert.equal(markCalls, 0);
});
