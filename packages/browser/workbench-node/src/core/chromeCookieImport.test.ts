import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserNodeChromeCookieImportFeature } from "./chromeCookieImport.ts";
import type {
  BrowserNodeChromeProfileId,
  BrowserNodeCookieImportResult
} from "./types.ts";

const profileId = "opaque" as BrowserNodeChromeProfileId;

test("Chrome profile discovery is cached for every Browser node", async () => {
  let calls = 0;
  const feature = createBrowserNodeChromeCookieImportFeature({
    hostApi: {
      async cancelChromeCookieImport() {},
      async discoverChromeCookieProfiles() {
        calls += 1;
        return {
          profiles: [{ id: profileId, name: "Default" }],
          status: "available"
        };
      },
      async importChromeCookies() {
        throw new Error("unused");
      }
    }
  });

  assert.ok(feature);
  const [first, second] = await Promise.all([
    feature.discover(),
    feature.discover()
  ]);
  assert.equal(calls, 1);
  assert.equal(first, second);
});

test("Chrome import dismissal follows the complete result matrix", async () => {
  const cases: Array<{
    dismisses: boolean;
    result: BrowserNodeCookieImportResult;
  }> = [
    {
      dismisses: false,
      result: {
        canceled: true,
        failed: 0,
        imported: 0,
        partial: false,
        skipped: 0,
        status: "canceled"
      }
    },
    {
      dismisses: false,
      result: {
        canceled: false,
        failed: 0,
        failureCode: "integrity_failed",
        failureStage: "integrity",
        imported: 0,
        partial: false,
        skipped: 0,
        status: "failed"
      }
    },
    {
      dismisses: false,
      result: {
        canceled: false,
        failed: 0,
        imported: 0,
        partial: false,
        skipped: 2,
        status: "completed"
      }
    },
    {
      dismisses: true,
      result: {
        canceled: false,
        failed: 1,
        imported: 1,
        partial: true,
        skipped: 2,
        status: "completed"
      }
    },
    {
      dismisses: true,
      result: {
        canceled: false,
        failed: 0,
        imported: 2,
        partial: false,
        skipped: 0,
        status: "completed"
      }
    }
  ];

  for (const [index, testCase] of cases.entries()) {
    let dismissed = false;
    const feature = createBrowserNodeChromeCookieImportFeature({
      hostApi: {
        async cancelChromeCookieImport() {},
        async discoverChromeCookieProfiles() {
          return { reason: "no-profiles", status: "unavailable" };
        },
        async importChromeCookies() {
          return testCase.result;
        }
      },
      prompt: {
        dismiss() {
          dismissed = true;
        },
        isDismissed: () => dismissed,
        subscribe: () => () => undefined
      }
    });
    assert.ok(feature);

    await feature.importProfile({
      nodeId: "browser",
      operationId: `operation-${index}`,
      profileId
    });

    assert.equal(dismissed, testCase.dismisses);
  }
});
