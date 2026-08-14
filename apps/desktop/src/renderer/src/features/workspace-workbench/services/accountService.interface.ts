import { createDecorator } from "@tutti-os/infra/di";
import type {
  AccountProductSummaryResponse,
  AccountUserInfo
} from "@tutti-os/client-tuttid-ts";

export interface AccountStoreState {
  error: string | null;
  loading: boolean;
  loginStatus: string | null;
  productSummary: AccountProductSummaryResponse | null;
  productSummaryError: string | null;
  productSummaryLoading: boolean;
  signingIn: boolean;
  signingOut: boolean;
  user: AccountUserInfo | null;
}

export interface IAccountService {
  readonly _serviceBrand: undefined;
  readonly store: AccountStoreState;
  refreshUserInfo(): Promise<void>;
  refreshProductSummary(options?: { force?: boolean }): Promise<void>;
  dismissRegistrationCreditsReward(rewardID: string): Promise<void>;
  startLogin(): Promise<{ error: string | null }>;
  logout(): Promise<void>;
}

export const IAccountService =
  createDecorator<IAccountService>("account-service");
