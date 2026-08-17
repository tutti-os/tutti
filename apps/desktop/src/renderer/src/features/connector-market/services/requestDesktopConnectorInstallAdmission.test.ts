import assert from "node:assert/strict";
import test from "node:test";

import { requestDesktopConnectorInstallAdmission } from "./requestDesktopConnectorInstallAdmission.ts";

test("connector install admission starts account login without reporting a successful launch", async () => {
  let loginCalls = 0;
  let notificationCalls = 0;

  await requestDesktopConnectorInstallAdmission(
    {
      async startLogin() {
        loginCalls += 1;
        return { error: null };
      }
    },
    {
      error() {
        notificationCalls += 1;
        return "notification-1";
      }
    },
    "Unable to start sign-in"
  );

  assert.equal(loginCalls, 1);
  assert.equal(notificationCalls, 0);
});

test("connector install admission reports an account login launch failure", async () => {
  const messages: Array<{ description?: string; title: string }> = [];

  await requestDesktopConnectorInstallAdmission(
    {
      async startLogin() {
        return { error: "Failed to fetch" };
      }
    },
    {
      error(message) {
        messages.push(message);
        return "notification-1";
      }
    },
    "Unable to start sign-in"
  );

  assert.deepEqual(messages, [
    {
      description: "Failed to fetch",
      title: "Unable to start sign-in"
    }
  ]);
});
