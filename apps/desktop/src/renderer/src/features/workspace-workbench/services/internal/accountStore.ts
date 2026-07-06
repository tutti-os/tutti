import { proxy } from "valtio";
import type { AccountStoreState } from "../accountService.interface";

export function createAccountStore(): AccountStoreState {
  return proxy({
    error: null,
    loading: false,
    loginStatus: null,
    productSummary: null,
    productSummaryError: null,
    productSummaryLoading: false,
    signingIn: false,
    signingOut: false,
    user: null
  });
}
