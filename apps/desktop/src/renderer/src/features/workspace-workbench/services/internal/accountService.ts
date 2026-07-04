import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopHostFilesApi } from "@preload/types";
import type { IAccountService } from "../accountService.interface";
import { createAccountStore } from "./accountStore.ts";

const loginStatusPollMs = 1000;

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
    | "getAccountUserInfo"
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

function readAccountError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Account request failed.";
}
