import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi } from "@preload/types";
import type { IAccountService } from "../accountService.interface";
import { createAccountStore } from "./accountStore.ts";

const loginStatusPollMs = 1000;
const productSummaryRefreshTtlMs = 15_000;

type ActiveLoginAttempt = {
  attemptID: string;
  expiresAt: number;
  loginURL: string;
};

export interface AccountServiceDependencies {
  hostFilesApi: Pick<DesktopHostFilesApi, "openExternal">;
  tuttidClient: Pick<
    TuttidClient,
    | "getAccountLoginStatus"
    | "getAccountProductSummary"
    | "getAccountUserInfo"
    | "dismissAccountRegistrationCreditsReward"
    | "logoutAccount"
    | "startAccountLogin"
  >;
}

export class AccountService implements IAccountService {
  readonly _serviceBrand: undefined;
  readonly store = createAccountStore();

  private readonly dependencies: AccountServiceDependencies;
  private activeLoginAttempt: ActiveLoginAttempt | null = null;
  private loginPoll: Promise<void> | null = null;
  private loginGeneration = 0;
  private productSummaryRefresh: Promise<void> | null = null;
  private productSummaryGeneration = 0;
  private productSummaryRefreshedAt = 0;

  constructor(dependencies: AccountServiceDependencies) {
    this.dependencies = dependencies;
  }

  async refreshUserInfo(): Promise<void> {
    this.store.loading = true;
    this.store.error = null;
    try {
      this.store.user =
        await this.dependencies.tuttidClient.getAccountUserInfo();
    } catch (error) {
      this.store.error = readAccountError(error);
    } finally {
      this.store.loading = false;
    }
  }

  async refreshProductSummary(options?: { force?: boolean }): Promise<void> {
    if (this.productSummaryRefresh) {
      return this.productSummaryRefresh;
    }
    if (
      !options?.force &&
      Date.now() - this.productSummaryRefreshedAt < productSummaryRefreshTtlMs
    ) {
      return;
    }
    const generation = this.productSummaryGeneration;
    const refresh = this.doRefreshProductSummary(generation).finally(() => {
      if (this.productSummaryRefresh === refresh) {
        this.productSummaryRefresh = null;
      }
    });
    this.productSummaryRefresh = refresh;
    return refresh;
  }

  private async doRefreshProductSummary(generation: number): Promise<void> {
    this.store.productSummaryLoading = true;
    this.store.productSummaryError = null;
    try {
      const summary =
        await this.dependencies.tuttidClient.getAccountProductSummary();
      if (this.productSummaryGeneration !== generation) {
        return;
      }
      // TEMP(debug): 模擬積分狀態，用來驗證 UI。切換方式（DevTools console）：
      //   localStorage.setItem("tutti.debug.creditsState", "zero")        // 餘額 0
      //   localStorage.setItem("tutti.debug.creditsState", "unavailable") // 顯示 unavailable
      //   localStorage.setItem("tutti.debug.creditsState", "error")       // 錯誤紅字
      //   localStorage.removeItem("tutti.debug.creditsState")             // 還原
      // 之後執行 accountService.refreshProductSummary({ force: true }) 或重開選單。
      applyDebugCreditsState(summary);
      this.store.productSummary = summary;
      this.productSummaryRefreshedAt = Date.now();
    } catch (error) {
      if (this.productSummaryGeneration !== generation) {
        return;
      }
      this.store.productSummaryError = readAccountError(error);
    } finally {
      if (this.productSummaryGeneration === generation) {
        this.store.productSummaryLoading = false;
      }
    }
  }

  async dismissRegistrationCreditsReward(rewardID: string): Promise<void> {
    const summary = this.store.productSummary;
    if (summary?.registration_credits_reward?.id === rewardID) {
      this.store.productSummary = {
        ...summary,
        registration_credits_reward: null
      };
    }
    try {
      await this.dependencies.tuttidClient.dismissAccountRegistrationCreditsReward(
        rewardID
      );
    } catch (error) {
      this.store.productSummaryError = readAccountError(error);
    }
  }

  async startLogin(): Promise<void> {
    if (this.store.signingIn) {
      return;
    }
    this.store.signingIn = true;
    this.store.error = null;
    try {
      const attempt = await this.ensureLoginAttempt();
      await this.dependencies.hostFilesApi.openExternal(attempt.loginURL);
      this.store.loginStatus = "pending";
      this.startLoginStatusPoll(attempt);
    } catch (error) {
      this.store.error = readAccountError(error);
    } finally {
      this.store.signingIn = false;
    }
  }

  async logout(): Promise<void> {
    if (this.store.signingOut) {
      return;
    }
    this.store.signingOut = true;
    this.store.error = null;
    this.cancelLoginPoll();
    try {
      await this.dependencies.tuttidClient.logoutAccount();
      this.store.user = null;
      this.productSummaryGeneration += 1;
      this.productSummaryRefresh = null;
      this.store.productSummary = null;
      this.store.productSummaryError = null;
      this.store.productSummaryLoading = false;
      this.productSummaryRefreshedAt = 0;
      this.store.loginStatus = null;
    } catch (error) {
      this.store.error = readAccountError(error);
    } finally {
      this.store.signingOut = false;
    }
  }

  private async ensureLoginAttempt(): Promise<ActiveLoginAttempt> {
    if (
      this.activeLoginAttempt &&
      Date.now() <= this.activeLoginAttempt.expiresAt
    ) {
      return this.activeLoginAttempt;
    }
    const started = await this.dependencies.tuttidClient.startAccountLogin();
    const attempt = {
      attemptID: started.attempt_id,
      expiresAt: started.expires_at,
      loginURL: started.login_url
    };
    this.activeLoginAttempt = attempt;
    return attempt;
  }

  private startLoginStatusPoll(attempt: ActiveLoginAttempt): void {
    if (
      this.loginPoll &&
      this.activeLoginAttempt?.attemptID === attempt.attemptID
    ) {
      return;
    }
    const generation = ++this.loginGeneration;
    this.loginPoll = this.pollLoginStatus(attempt, generation).finally(() => {
      if (this.loginGeneration === generation) {
        this.loginPoll = null;
      }
    });
  }

  private cancelLoginPoll(): void {
    this.loginGeneration += 1;
    this.loginPoll = null;
    this.activeLoginAttempt = null;
  }

  private async pollLoginStatus(
    attempt: ActiveLoginAttempt,
    generation: number
  ): Promise<void> {
    try {
      while (
        this.loginGeneration === generation &&
        Date.now() <= attempt.expiresAt
      ) {
        const status =
          await this.dependencies.tuttidClient.getAccountLoginStatus(
            attempt.attemptID
          );
        if (this.loginGeneration !== generation) {
          return;
        }
        this.store.loginStatus = status.status;
        if (status.status === "completed") {
          this.activeLoginAttempt = null;
          await this.refreshUserInfo();
          this.productSummaryGeneration += 1;
          this.productSummaryRefresh = null;
          this.store.productSummary = null;
          this.store.productSummaryError = null;
          this.store.productSummaryLoading = false;
          this.productSummaryRefreshedAt = 0;
          await this.refreshProductSummary({ force: true });
          return;
        }
        if (status.status === "failed" || status.status === "expired") {
          throw new Error(status.error ?? status.status);
        }
        await delay(loginStatusPollMs);
      }
      throw new Error("Login timed out");
    } catch (error) {
      if (this.loginGeneration !== generation) {
        return;
      }
      this.activeLoginAttempt = null;
      this.store.error = readAccountError(error);
      this.store.loginStatus = "failed";
    } finally {
      if (this.loginGeneration === generation) {
        this.activeLoginAttempt = null;
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// TEMP(debug): 依 localStorage 覆寫積分 summary，僅供 UI 驗證，正式上線前移除。
function applyDebugCreditsState(summary: {
  credits?: { available_credits?: number | null } | null;
}): void {
  let state: string | null = null;
  try {
    state = globalThis.localStorage?.getItem("tutti.debug.creditsState");
  } catch {
    state = null;
  }
  if (!state) {
    return;
  }
  if (state === "error") {
    throw new Error("insufficient credits (debug)");
  }
  const credits = summary.credits ?? {};
  if (state === "zero") {
    summary.credits = { ...credits, available_credits: 0 };
  } else if (state === "unavailable") {
    summary.credits = { ...credits, available_credits: null };
  }
}

function readAccountError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Account request failed.";
}
