import assert from "node:assert/strict";
import test from "node:test";
import type {
  MobileRemoteAccessClient,
  MobileRemotePairingChallenge
} from "@tutti-os/client-tuttid-ts";
import { MobileRemoteAccessService } from "./mobileRemoteAccessService.ts";

test("MobileRemoteAccessService starts, observes claim, and confirms pairing", async () => {
  const calls: string[] = [];
  const initialChallenge = challenge("awaiting_claim");
  const claimedChallenge = challenge("awaiting_confirmation");
  const confirmedChallenge = challenge("confirmed");
  const service = new MobileRemoteAccessService(
    {
      async startMobileRemotePairing() {
        calls.push("start");
        return { challenge: initialChallenge, qrPayload: "qr-payload" };
      },
      async getMobileRemotePairingChallenge(challengeID) {
        calls.push(`status:${challengeID}`);
        return { challenge: claimedChallenge };
      },
      async confirmMobileRemotePairing(challengeID) {
        calls.push(`confirm:${challengeID}`);
        return {
          challenge: confirmedChallenge,
          pairing: {
            pairingId: "pairing-1",
            controllerUserDeviceId: "phone-device",
            targetUserDeviceId: "desktop-device",
            state: "active",
            revision: 1,
            confirmedAt: "2026-07-23T10:00:01Z"
          }
        };
      },
      async listMobileRemotePairings() {
        calls.push("list");
        return { pairings: [] };
      },
      async revokeMobileRemotePairing() {
        throw new Error("not used");
      }
    } satisfies MobileRemoteAccessClient,
    0
  );

  await service.startPairing();
  assert.equal(service.store.qrPayload, "qr-payload");
  await waitFor(() => service.store.challenge?.state === "confirmed");

  assert.deepEqual(calls, [
    "start",
    "status:challenge-1",
    "confirm:challenge-1",
    "list"
  ]);
  assert.equal(service.store.qrPayload, null);
  assert.equal(service.store.error, null);
});

test("MobileRemoteAccessService cancels an active pairing poll", async () => {
  let statusCalls = 0;
  const service = new MobileRemoteAccessService(
    {
      async startMobileRemotePairing() {
        return {
          challenge: challenge("awaiting_claim"),
          qrPayload: "qr-payload"
        };
      },
      async getMobileRemotePairingChallenge() {
        statusCalls += 1;
        return { challenge: challenge("awaiting_claim") };
      },
      async confirmMobileRemotePairing() {
        throw new Error("not used");
      },
      async listMobileRemotePairings() {
        return { pairings: [] };
      },
      async revokeMobileRemotePairing() {
        throw new Error("not used");
      }
    } satisfies MobileRemoteAccessClient,
    10
  );

  await service.startPairing();
  service.cancelPairing();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(statusCalls, 0);
  assert.equal(service.store.qrPayload, null);
  assert.equal(service.store.challenge, null);
});

function challenge(state: string): MobileRemotePairingChallenge {
  return {
    challengeId: "challenge-1",
    targetUserDeviceId: "desktop-device",
    state,
    revision: 1,
    expiresAt: "2026-07-23T10:05:00Z"
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for mobile remote state");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
