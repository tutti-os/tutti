import assert from "node:assert/strict";
import test from "node:test";
import { startWorkspaceAccountLogin } from "./workspaceAccountLogin.ts";

test("top-right account login reports a daemon failure to the user", async () => {
  const messages: Array<{ description?: string; title: string }> = [];
  await startWorkspaceAccountLogin(
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

test("top-right account login stays quiet after the browser opens", async () => {
  let notificationCount = 0;

  await startWorkspaceAccountLogin(
    {
      async startLogin() {
        return { error: null };
      }
    },
    {
      error() {
        notificationCount += 1;
        return "notification-1";
      }
    },
    "Unable to start sign-in"
  );

  assert.equal(notificationCount, 0);
});

test("top-right account login ignores an unrelated shared account error", async () => {
  let notificationCount = 0;

  await startWorkspaceAccountLogin(
    {
      async startLogin() {
        return { error: null };
      }
    },
    {
      error() {
        notificationCount += 1;
        return "notification-1";
      }
    },
    "Unable to start sign-in"
  );

  assert.equal(notificationCount, 0);
});
