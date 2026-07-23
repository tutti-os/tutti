import { controlPlaneBaseURL, mobileClientVersion } from "../config";
import {
  deviceLink,
  mobileSecurity,
  type DeviceIdentity
} from "../native/mobileNative";
import { accountCookie, readJSON } from "./http";
import {
  base64URLToStandard,
  deviceLinkProof,
  identityProof,
  pairingClaimProof,
  standardBase64ToURL,
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

interface DeviceLinkICE {
  candidates: string[];
  pwd: string;
  ufrag: string;
}

interface DeviceLinkDescription extends DeviceLinkICE {
  fingerprint: string;
}

interface DeviceLinkAttempt {
  attemptId: string;
  callerFingerprint: string;
  callerIce: DeviceLinkICE;
  expiresAt: string;
  ownerFingerprint?: string;
  ownerIce?: DeviceLinkICE;
  state: "awaiting_owner" | "ready";
  stunEndpoints?: string[];
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

export async function connectPairedDevice(
  sessionId: string,
  pairingId: string
): Promise<void> {
  const identity = await mobileSecurity.getOrCreateIdentity();
  await registerIdentity(sessionId, identity);
  try {
    let local = parseDeviceLinkDescription(
      await deviceLink.prepareLink("[]", 10_000)
    );
    let attempt = await createDeviceLinkAttempt(
      sessionId,
      identity.deviceId,
      pairingId,
      local
    );
    if ((attempt.stunEndpoints?.length ?? 0) > 0) {
      local = parseDeviceLinkDescription(
        await deviceLink.prepareLink(
          JSON.stringify(attempt.stunEndpoints),
          10_000
        )
      );
      attempt = await updateDeviceLinkParticipant(
        sessionId,
        identity.deviceId,
        pairingId,
        attempt.attemptId,
        local
      );
    }
    const getSignature = standardBase64ToURL(
      await mobileSecurity.sign(
        deviceLinkProof("get", pairingId, attempt.attemptId, "")
      )
    );
    const deadline = Date.parse(attempt.expiresAt);
    while (Date.now() < deadline) {
      if (
        attempt.state === "ready" &&
        attempt.ownerIce &&
        attempt.ownerFingerprint
      ) {
        await deviceLink.connectLink(
          JSON.stringify({
            candidates: attempt.ownerIce.candidates,
            fingerprint: attempt.ownerFingerprint,
            pwd: attempt.ownerIce.pwd,
            ufrag: attempt.ownerIce.ufrag
          }),
          true,
          30_000
        );
        return;
      }
      await delay(500);
      attempt = await getDeviceLinkAttempt(
        sessionId,
        identity.deviceId,
        pairingId,
        attempt.attemptId,
        getSignature
      );
    }
    throw new Error("device-link attempt expired");
  } catch (error) {
    await deviceLink.closeLink().catch(() => undefined);
    throw error;
  }
}

async function createDeviceLinkAttempt(
  sessionId: string,
  deviceId: string,
  pairingId: string,
  local: DeviceLinkDescription
): Promise<DeviceLinkAttempt> {
  const signature = await mobileSecurity.sign(
    deviceLinkProof("create", pairingId, "", local.fingerprint)
  );
  const response = await controlPlaneRequest<{ attempt: DeviceLinkAttempt }>(
    sessionId,
    `/device-pairings/${encodeURIComponent(pairingId)}/device-link-attempts?deviceId=${encodeURIComponent(deviceId)}`,
    {
      body: JSON.stringify({
        candidates: [],
        ephemeralFingerprint: local.fingerprint,
        ice: {
          candidates: local.candidates,
          pwd: local.pwd,
          ufrag: local.ufrag
        },
        identitySignature: signature,
        protocolVersion: 2
      }),
      method: "POST"
    }
  );
  return response.attempt;
}

async function updateDeviceLinkParticipant(
  sessionId: string,
  deviceId: string,
  pairingId: string,
  attemptId: string,
  local: DeviceLinkDescription
): Promise<DeviceLinkAttempt> {
  const signature = await mobileSecurity.sign(
    deviceLinkProof("update", pairingId, attemptId, local.fingerprint)
  );
  const response = await controlPlaneRequest<{ attempt: DeviceLinkAttempt }>(
    sessionId,
    `/device-pairings/${encodeURIComponent(pairingId)}/device-link-attempts/${encodeURIComponent(attemptId)}/participant?deviceId=${encodeURIComponent(deviceId)}`,
    {
      body: JSON.stringify({
        candidates: [],
        ephemeralFingerprint: local.fingerprint,
        ice: {
          candidates: local.candidates,
          pwd: local.pwd,
          ufrag: local.ufrag
        },
        identitySignature: signature,
        protocolVersion: 2
      }),
      method: "POST"
    }
  );
  return response.attempt;
}

async function getDeviceLinkAttempt(
  sessionId: string,
  deviceId: string,
  pairingId: string,
  attemptId: string,
  identitySignature: string
): Promise<DeviceLinkAttempt> {
  const response = await controlPlaneRequest<{ attempt: DeviceLinkAttempt }>(
    sessionId,
    `/device-pairings/${encodeURIComponent(pairingId)}/device-link-attempts/${encodeURIComponent(attemptId)}?deviceId=${encodeURIComponent(deviceId)}&identitySignature=${encodeURIComponent(identitySignature)}`,
    { method: "GET" }
  );
  return response.attempt;
}

function parseDeviceLinkDescription(raw: string): DeviceLinkDescription {
  const parsed = JSON.parse(raw) as Partial<DeviceLinkDescription>;
  if (
    typeof parsed.fingerprint !== "string" ||
    typeof parsed.ufrag !== "string" ||
    typeof parsed.pwd !== "string" ||
    !Array.isArray(parsed.candidates) ||
    parsed.candidates.length === 0
  ) {
    throw new Error("invalid local DeviceLink description");
  }
  return {
    candidates: parsed.candidates.map(String),
    fingerprint: parsed.fingerprint,
    pwd: parsed.pwd,
    ufrag: parsed.ufrag
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
