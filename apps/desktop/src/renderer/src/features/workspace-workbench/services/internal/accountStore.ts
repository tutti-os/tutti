import { proxy } from "valtio";
import type { AccountStoreState } from "../accountService.interface";

export function createAccountStore(): AccountStoreState {
  return proxy({
    error: null,
    loading: false,
    loginStatus: null,
    signingIn: false,
    signingOut: false,
    user: null
  });
}
