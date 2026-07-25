import { AppState } from "react-native";
import { deviceLink, mobileSecurity } from "./mobileNative";
import {
  sendEmailCode,
  signInWithGitHub,
  verifyEmailCode
} from "../services/accountClient";
import {
  claimPairing,
  connectPairedDevice,
  getPairingChallenge,
  listDevices,
  listPairings,
  parsePairingQR,
  registerCurrentDevice
} from "../services/pairingClient";
import { createRemoteTuttidClient } from "../services/remoteTuttidClient";
import type { MobileServicePorts } from "../services/servicePorts";

export function createMobileServicePorts(): MobileServicePorts {
  return {
    account: {
      sendEmailCode,
      signInWithGitHub,
      verifyEmailCode
    },
    clock: {
      now: () => Date.now(),
      schedule(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }
    },
    deviceLink,
    deviceSecurity: mobileSecurity,
    lifecycle: {
      subscribe(listener) {
        const subscription = AppState.addEventListener("change", (state) =>
          listener(state === "active")
        );
        return () => subscription.remove();
      }
    },
    pairing: {
      claimPairing,
      connectPairedDevice,
      getPairingChallenge,
      listDevices,
      listPairings,
      parsePairingQR,
      registerCurrentDevice
    },
    sessionStorage: mobileSecurity,
    createRemoteClient: () => createRemoteTuttidClient(deviceLink)
  };
}
