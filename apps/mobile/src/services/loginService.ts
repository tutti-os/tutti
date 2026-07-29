import type { AccountSession } from "./mobileDomain";
import { ObservableService } from "./observableService";
import type { AccountPort } from "./servicePorts";

export type LoginErrorCode =
  | "browser_login_cancelled"
  | "request_failed"
  | null;

export interface LoginSnapshot {
  code: string;
  email: string;
  errorCode: LoginErrorCode;
  pending: "email" | "github" | null;
  step: "email" | "code";
}

export class LoginService extends ObservableService<LoginSnapshot> {
  readonly _serviceBrand: undefined;
  private snapshot: LoginSnapshot = {
    code: "",
    email: "",
    errorCode: null,
    pending: null,
    step: "email"
  };

  constructor(
    private readonly account: AccountPort,
    private readonly onAuthenticated: (session: AccountSession) => Promise<void>
  ) {
    super();
  }

  getSnapshot = (): LoginSnapshot => this.snapshot;

  setEmail(email: string): void {
    this.patch({ email });
  }

  setCode(code: string): void {
    this.patch({ code });
  }

  async submitEmail(): Promise<void> {
    if (this.snapshot.pending !== null) return;
    this.patch({ errorCode: null, pending: "email" });
    try {
      if (this.snapshot.step === "email") {
        await this.account.sendEmailCode(this.snapshot.email);
        this.patch({ pending: null, step: "code" });
        return;
      }
      await this.onAuthenticated(
        await this.account.verifyEmailCode(
          this.snapshot.email,
          this.snapshot.code
        )
      );
    } catch {
      this.patch({ errorCode: "request_failed", pending: null });
      return;
    }
    this.patch({ pending: null });
  }

  async submitGitHub(): Promise<void> {
    if (this.snapshot.pending !== null) return;
    this.patch({ errorCode: null, pending: "github" });
    try {
      await this.onAuthenticated(await this.account.signInWithGitHub());
    } catch (cause) {
      const cancelled =
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "BROWSER_LOGIN_CANCELLED";
      this.patch({
        errorCode: cancelled ? "browser_login_cancelled" : "request_failed",
        pending: null
      });
      return;
    }
    this.patch({ pending: null });
  }

  dispose(): void {
    this.clearListeners();
  }

  private patch(patch: Partial<LoginSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emitChange();
  }
}
