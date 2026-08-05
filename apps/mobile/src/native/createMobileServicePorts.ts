import { DeviceEventEmitter, NativeEventEmitter } from "react-native";
import { createAppLifecyclePort } from "./appLifecyclePort";
import { appLifecycle, deviceLink, mobileSecurity } from "./mobileNative";
import { signInWithBrowser } from "../services/accountClient";
import {
  claimPairing,
  connectPairedDevice as connectPairedDeviceRequest,
  getPairingChallenge,
  listDevices,
  listPairings,
  registerCurrentDevice
} from "../services/pairingClient";
import { createRemoteTuttidClient } from "../services/remoteTuttidClient";
import type { MobileServicePorts } from "../services/servicePorts";
import { DeviceLinkAttemptEvents } from "../services/deviceLinkAttemptEvents";
import { parseAgentLiveDeliveries } from "./agentLiveNativeBridge";
import { accountBaseURL } from "../config";

const AGENT_LIVE_EVENT_NAME = "TuttiDeviceLinkAgentLive";
const appLifecycleEvents = new NativeEventEmitter(appLifecycle);

export function createMobileServicePorts(): MobileServicePorts {
  let nextAgentLiveSubscriptionGeneration = 0;
  const diagnostics = {
    record(event: Parameters<MobileServicePorts["diagnostics"]["record"]>[0]) {
      console.info("[TuttiMobile]", JSON.stringify(event));
    }
  };
  const attemptEvents = new DeviceLinkAttemptEvents();
  return {
    account: {
      signInWithBrowser
    },
    appLifecycle: createAppLifecyclePort(appLifecycle, appLifecycleEvents),
    clock: {
      now: () => Date.now(),
      schedule(delayMs, callback) {
        const timer = setTimeout(callback, delayMs);
        return { cancel: () => clearTimeout(timer) };
      }
    },
    deviceLink: {
      closeLink: () => deviceLink.closeLink(),
      requestAgentHTTP: (method, path, body, timeoutMillis) =>
        deviceLink.requestAgentHTTP(method, path, body, timeoutMillis),
      subscribeAgentLive(workspaceId, listener) {
        let active = true;
        const subscriptionGeneration = ++nextAgentLiveSubscriptionGeneration;
        const subscription = DeviceEventEmitter.addListener(
          AGENT_LIVE_EVENT_NAME,
          (payload: string) => {
            if (!active) return;
            for (const delivery of parseAgentLiveDeliveries(
              workspaceId,
              subscriptionGeneration,
              payload
            )) {
              listener(delivery);
            }
          }
        );
        void deviceLink
          .startAgentLive(workspaceId, subscriptionGeneration)
          .catch(() => {
            if (active) {
              listener({
                kind: "connection",
                reason: "subscribe_failed",
                status: "disconnected"
              });
            }
          });
        return {
          close() {
            if (!active) return;
            active = false;
            subscription.remove();
            void deviceLink.stopAgentLive().catch(() => undefined);
          }
        };
      }
    },
    diagnostics,
    legacySessionCookie: {
      clear: () => mobileSecurity.clearLegacySessionCookie(accountBaseURL)
    },
    pairing: {
      claimPairing,
      connectPairedDevice: (sessionId, pairingId, isCurrent) =>
        connectPairedDeviceRequest(sessionId, pairingId, isCurrent, {
          attemptEvents,
          diagnostics
        }),
      getPairingChallenge,
      listDevices,
      listPairings,
      registerCurrentDevice
    },
    qrCodeScanner: {
      start() {
        return {
          cancel: () => mobileSecurity.cancelQRCodeScan(),
          result: mobileSecurity.scanQRCode()
        };
      }
    },
    sessionStorage: mobileSecurity,
    createRemoteClient: () => createRemoteTuttidClient(deviceLink)
  };
}
