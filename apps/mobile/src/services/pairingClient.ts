import { controlPlaneBaseURL, mobileClientVersion } from "../config";
import { mobileSecurity, type DeviceIdentity } from "../native/mobileNative";
import { accountCookie, readJSON } from "./http";
import {
  base64URLToStandard,
  identityProof,
  pairingClaimProof,
  type PairingQRPayload
} from "./pairingProtocol";

export { parsePairingQR } from "./pairingProtocol";

export interface DevicePairing {
  confirmedAt?: string;
  controllerUserDeviceId: string;
  pairingId: string;
  revision: string;
  state: string;
  targetUserDeviceId: string;
}

export interface UserDevice {
  displayName: string;
  platform: string;
  reportedName: string;
  userDeviceId: string;
}

interface PairingChallenge {
  challengeId: string;
  expiresAt: string;
  pairingId?: string;
  state: string;
}

export async function claimPairing(
  sessionId: string,
  payload: PairingQRPayload
): Promise<PairingChallenge> {
  const identity = await mobileSecurity.getOrCreateIdentity();
  await registerIdentity(sessionId, identity);
  const signature = await mobileSecurity.sign(
    pairingClaimProof(payload.challengeId, payload.secret)
  );
  const response = await controlPlaneRequest<{ challenge: PairingChallenge }>(
    sessionId,
    `/device-pairing-challenges/${encodeURIComponent(payload.challengeId)}/claim`,
    {
      body: JSON.stringify({
        controllerDeviceId: identity.deviceId,
        secret: payload.secret,
        signature
      }),
      method: "POST"
    }
  );
  return response.challenge;
}

export async function getPairingChallenge(
  sessionId: string,
  challengeId: string
): Promise<PairingChallenge> {
  const response = await controlPlaneRequest<{ challenge: PairingChallenge }>(
    sessionId,
    `/device-pairing-challenges/${encodeURIComponent(challengeId)}`,
    { method: "GET" }
  );
  return response.challenge;
}

export async function listPairings(
  sessionId: string
): Promise<DevicePairing[]> {
  const response = await controlPlaneRequest<{ pairings?: DevicePairing[] }>(
    sessionId,
    "/device-pairings",
    { method: "GET" }
  );
  return response.pairings ?? [];
}

export async function listDevices(sessionId: string): Promise<UserDevice[]> {
  const response = await controlPlaneRequest<{ devices?: UserDevice[] }>(
    sessionId,
    "/devices",
    { method: "GET" }
  );
  return response.devices ?? [];
}

async function registerIdentity(
  sessionId: string,
  identity: DeviceIdentity
): Promise<void> {
  const proof = await mobileSecurity.sign(
    identityProof(identity.deviceId, identity.publicKey)
  );
  await controlPlaneRequest(sessionId, "/devices/current", {
    body: JSON.stringify({
      arch: identity.arch,
      clientVersion: mobileClientVersion,
      deviceId: identity.deviceId,
      platform: "android",
      publicIdentity: {
        algorithm: "ed25519",
        proof,
        publicKey: base64URLToStandard(identity.publicKey)
      },
      reportedName: identity.deviceName
    }),
    method: "PUT"
  });
}

async function controlPlaneRequest<T>(
  sessionId: string,
  path: string,
  init: RequestInit
): Promise<T> {
  const response = await fetch(`${controlPlaneBaseURL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Cookie: accountCookie(sessionId),
      ...(init.body ? { "Content-Type": "application/json" } : {})
    }
  });
  return readJSON<T>(response);
}
