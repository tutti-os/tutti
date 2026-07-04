import { createDecorator } from "@tutti-os/infra/di";
import type { AccountUserInfo } from "@tutti-os/client-tuttid-ts";

export interface AccountStoreState {
  error: string | null;
  loading: boolean;
  loginStatus: string | null;
  signingIn: boolean;
  signingOut: boolean;
  user: AccountUserInfo | null;
}

export interface IAccountService {
  readonly _serviceBrand: undefined;
  readonly store: AccountStoreState;
  refreshUserInfo(): Promise<void>;
  startLogin(): Promise<void>;
  logout(): Promise<void>;
}

export const IAccountService =
  createDecorator<IAccountService>("account-service");
