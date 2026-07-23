import { proxy } from "valtio";
import type { MobileRemoteAccessStoreState } from "../mobileRemoteAccessService.interface";

export function createMobileRemoteAccessStore(): MobileRemoteAccessStoreState {
  return proxy({
    challenge: null,
    confirming: false,
    error: null,
    loadingPairings: false,
    pairings: [],
    qrPayload: null,
    revokingPairingID: null,
    starting: false
  });
}
