import assert from "node:assert/strict";
import test from "node:test";
import { createTuttidClient } from "@tutti-os/client-tuttid-ts";
import { AccountService } from "./accountService.ts";

test("AccountService opens login URL and refreshes user after completion", async () => {
  const opened: string[] = [];
  const service = new AccountService({
    hostFilesApi: {
      async openExternal(url) {
        opened.push(url);
      },
    },
    tuttidClient: {
      async startAccountLogin() {
        return {
          attempt_id: "attempt-1",
          expires_at: Date.now() + 10_000,
          login_url: "https://tutti.sh/auth/login?state=test",
        };
      },
      async getAccountLoginStatus() {
        return {
          attempt_id: "attempt-1",
          expires_at: Date.now() + 10_000,
          status: "completed" as const,
        };
      },
      async getAccountUserInfo() {
        return {
          user_id: "user-1",
          name: "Tutti User",
          email: "user@example.com",
        };
      },
      async getAccountProductSummary() {
        return {
          user: {
            user_id: "user-1",
            name: "Tutti User",
            email: "user@example.com",
          },
          membership: {
            tier_key: "pro",
            display_name: "Pro",
          },
          membership_access: "active" as const,
          credits: {
            available_credits: "2450.52",
          },
          links: {
            plan_url: "https://tutti.sh/profile/plan",
            usage_url: "https://tutti.sh/profile/usage",
            settings_url: "https://tutti.sh/profile/settings",
          },
        };
      },
      async dismissAccountRegistrationCreditsReward() {},
      async logoutAccount() {},
    },
  });

  const result = await service.startLogin();

  assert.deepEqual(result, { error: null });
  assert.deepEqual(opened, ["https://tutti.sh/auth/login?state=test"]);
  assert.equal(service.store.signingIn, false);
  await waitFor(() => service.store.user?.user_id === "user-1");
  await waitFor(
    () => service.store.productSummary?.membership?.display_name === "Pro",
  );
});

test("AccountService returns the current login failure independently", async () => {
  const service = new AccountService({
    hostFilesApi: {
      async openExternal() {},
    },
    tuttidClient: {
      async startAccountLogin() {
        throw new Error("login daemon unavailable");
      },
      async getAccountLoginStatus() {
        throw new Error("unexpected status");
      },
      async getAccountUserInfo() {
        return null;
      },
      async getAccountProductSummary() {
        throw new Error("unexpected product summary refresh");
      },
      async dismissAccountRegistrationCreditsReward() {},
      async logoutAccount() {},
    },
  });

  const result = await service.startLogin();

  assert.deepEqual(result, { error: "login daemon unavailable" });
  assert.equal(service.store.error, "login daemon unavailable");
});

test("AccountService recovers login after the managed daemon restarts", async () => {
  let starts = 0;
  const delays: number[] = [];
  const opened: string[] = [];
  const service = new AccountService({
    delay: async (milliseconds) => {
      delays.push(milliseconds);
    },
    hostFilesApi: {
      async openExternal(url) {
        opened.push(url);
      },
    },
    tuttidClient: createTuttidClient({
      fetch: async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        if (url.pathname === "/v1/account/login/start") {
          starts += 1;
          if (starts < 3) throw new TypeError("Failed to fetch");
          return Response.json({
            attempt_id: "attempt-recovered",
            expires_at: Date.now() + 60_000,
            login_url: "https://example.test/login",
          });
        }
        return Response.json({ status: "pending" });
      },
    }),
  });

  const result = await service.startLogin();

  assert.deepEqual(result, { error: null });
  assert.equal(starts, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.deepEqual(opened, ["https://example.test/login"]);
});

test("AccountService reopens the active login URL without starting another attempt", async () => {
  const opened: string[] = [];
  let starts = 0;
  const service = new AccountService({
    hostFilesApi: {
      async openExternal(url) {
        opened.push(url);
      },
    },
    tuttidClient: {
      async startAccountLogin() {
        starts += 1;
        return {
          attempt_id: "attempt-1",
          expires_at: Date.now() + 10_000,
          login_url: "https://tutti.sh/auth/login?state=test",
        };
      },
      async getAccountLoginStatus() {
        return await new Promise<never>(() => {});
      },
      async getAccountUserInfo() {
        return null;
      },
      async getAccountProductSummary() {
        throw new Error("unexpected product summary refresh");
      },
      async dismissAccountRegistrationCreditsReward() {},
      async logoutAccount() {},
    },
  });

  await service.startLogin();
  await service.startLogin();

  assert.equal(starts, 1);
  assert.deepEqual(opened, [
    "https://tutti.sh/auth/login?state=test",
    "https://tutti.sh/auth/login?state=test",
  ]);
  assert.equal(service.store.signingIn, false);
  assert.equal(service.store.loginStatus, "pending");
});

test("AccountService refreshes product summary with single-flight and preserves stale value on error", async () => {
  let calls = 0;
  let resolveFirst!: () => void;
  const firstRefresh = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const service = new AccountService({
    hostFilesApi: {
      async openExternal() {},
    },
    tuttidClient: {
      async startAccountLogin() {
        throw new Error("unexpected login");
      },
      async getAccountLoginStatus() {
        throw new Error("unexpected status");
      },
      async getAccountUserInfo() {
        return null;
      },
      async getAccountProductSummary() {
        calls += 1;
        if (calls === 1) {
          await firstRefresh;
          return {
            user: null,
            membership: null,
            membership_access: "unknown" as const,
            credits: {
              available_credits: "100.25",
            },
            links: {
              plan_url: "https://tutti.sh/profile/plan",
              usage_url: "https://tutti.sh/profile/usage",
              settings_url: "https://tutti.sh/profile/settings",
            },
          };
        }
        throw new Error("summary unavailable");
      },
      async dismissAccountRegistrationCreditsReward() {},
      async logoutAccount() {},
    },
  });

  const refreshA = service.refreshProductSummary({ force: true });
  const refreshB = service.refreshProductSummary({ force: true });
  assert.equal(calls, 1);
  resolveFirst();
  await Promise.all([refreshA, refreshB]);
  assert.equal(
    service.store.productSummary?.credits?.available_credits,
    "100.25",
  );

  await service.refreshProductSummary({ force: true });
  assert.equal(calls, 2);
  assert.equal(
    service.store.productSummary?.credits?.available_credits,
    "100.25",
  );
  assert.equal(service.store.productSummaryError, "summary unavailable");
});

test("AccountService dismisses the current registration credits reward", async () => {
  const dismissed: string[] = [];
  const service = new AccountService({
    hostFilesApi: {
      async openExternal() {},
    },
    tuttidClient: {
      async startAccountLogin() {
        throw new Error("unexpected login");
      },
      async getAccountLoginStatus() {
        throw new Error("unexpected status");
      },
      async getAccountUserInfo() {
        return null;
      },
      async getAccountProductSummary() {
        return {
          user: null,
          membership: null,
          membership_access: "unknown" as const,
          credits: {
            available_credits: "500",
          },
          registration_credits_reward: {
            id: "registrationCreditsToastShown:user-1:grant-1",
            grant_no: "grant-1",
            credits: 500,
            created_at: "2026-07-07T00:00:00Z",
          },
          links: {
            plan_url: "https://tutti.sh/profile/plan",
            usage_url: "https://tutti.sh/profile/usage",
            settings_url: "https://tutti.sh/profile/settings",
          },
        };
      },
      async dismissAccountRegistrationCreditsReward(rewardID) {
        dismissed.push(rewardID);
      },
      async logoutAccount() {},
    },
  });

  await service.refreshProductSummary({ force: true });
  assert.equal(
    service.store.productSummary?.registration_credits_reward?.id,
    "registrationCreditsToastShown:user-1:grant-1",
  );

  await service.dismissRegistrationCreditsReward(
    "registrationCreditsToastShown:user-1:grant-1",
  );

  assert.deepEqual(dismissed, ["registrationCreditsToastShown:user-1:grant-1"]);
  assert.equal(service.store.productSummary?.registration_credits_reward, null);
});

test("AccountService logout clears product summary", async () => {
  const service = new AccountService({
    hostFilesApi: {
      async openExternal() {},
    },
    tuttidClient: {
      async startAccountLogin() {
        throw new Error("unexpected login");
      },
      async getAccountLoginStatus() {
        throw new Error("unexpected status");
      },
      async getAccountUserInfo() {
        return null;
      },
      async getAccountProductSummary() {
        return {
          user: null,
          membership: null,
          membership_access: "unknown" as const,
          credits: {
            available_credits: "100",
          },
          links: {
            plan_url: "https://tutti.sh/profile/plan",
            usage_url: "https://tutti.sh/profile/usage",
            settings_url: "https://tutti.sh/profile/settings",
          },
        };
      },
      async dismissAccountRegistrationCreditsReward() {},
      async logoutAccount() {},
    },
  });

  await service.refreshProductSummary({ force: true });
  assert.equal(service.store.productSummary?.credits?.available_credits, "100");

  await service.logout();

  assert.equal(service.store.productSummary, null);
  assert.equal(service.store.productSummaryError, null);
  assert.equal(service.store.productSummaryLoading, false);
});

test("AccountService ignores product summary responses after logout", async () => {
  let resolveRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const service = new AccountService({
    hostFilesApi: {
      async openExternal() {},
    },
    tuttidClient: {
      async startAccountLogin() {
        throw new Error("unexpected login");
      },
      async getAccountLoginStatus() {
        throw new Error("unexpected status");
      },
      async getAccountUserInfo() {
        return null;
      },
      async getAccountProductSummary() {
        await refreshGate;
        return {
          user: null,
          membership: null,
          membership_access: "unknown" as const,
          credits: {
            available_credits: "100",
          },
          links: {
            plan_url: "https://tutti.sh/profile/plan",
            usage_url: "https://tutti.sh/profile/usage",
            settings_url: "https://tutti.sh/profile/settings",
          },
        };
      },
      async dismissAccountRegistrationCreditsReward() {},
      async logoutAccount() {},
    },
  });

  const refresh = service.refreshProductSummary({ force: true });
  await service.logout();
  resolveRefresh();
  await refresh;

  assert.equal(service.store.productSummary, null);
  assert.equal(service.store.productSummaryError, null);
  assert.equal(service.store.productSummaryLoading, false);
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
