import assert from "node:assert/strict";
import test from "node:test";
import { AccountService } from "./accountService.ts";

test("AccountService opens login URL and refreshes user after completion", async () => {
  const opened: string[] = [];
  const service = new AccountService({
    hostFilesApi: {
      async openExternal(url) {
        opened.push(url);
      }
    },
    tuttidClient: {
      async startAccountLogin() {
        return {
          attempt_id: "attempt-1",
          expires_at: Date.now() + 10_000,
          login_url: "https://tutti.sh/auth/login?state=test"
        };
      },
      async getAccountLoginStatus() {
        return {
          attempt_id: "attempt-1",
          expires_at: Date.now() + 10_000,
          status: "completed" as const
        };
      },
      async getAccountUserInfo() {
        return {
          user_id: "user-1",
          name: "Tutti User",
          email: "user@example.com"
        };
      },
      async logoutAccount() {}
    }
  });

  await service.startLogin();

  assert.deepEqual(opened, ["https://tutti.sh/auth/login?state=test"]);
  assert.equal(service.store.signingIn, false);
  await waitFor(() => service.store.user?.user_id === "user-1");
});

test("AccountService reopens the active login URL without starting another attempt", async () => {
  const opened: string[] = [];
  let starts = 0;
  const service = new AccountService({
    hostFilesApi: {
      async openExternal(url) {
        opened.push(url);
      }
    },
    tuttidClient: {
      async startAccountLogin() {
        starts += 1;
        return {
          attempt_id: "attempt-1",
          expires_at: Date.now() + 10_000,
          login_url: "https://tutti.sh/auth/login?state=test"
        };
      },
      async getAccountLoginStatus() {
        return await new Promise<never>(() => {});
      },
      async getAccountUserInfo() {
        return null;
      },
      async logoutAccount() {}
    }
  });

  await service.startLogin();
  await service.startLogin();

  assert.equal(starts, 1);
  assert.deepEqual(opened, [
    "https://tutti.sh/auth/login?state=test",
    "https://tutti.sh/auth/login?state=test"
  ]);
  assert.equal(service.store.signingIn, false);
  assert.equal(service.store.loginStatus, "pending");
});

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(assertion(), true);
}
