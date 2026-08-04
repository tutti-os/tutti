import { Platform } from "react-native";
import { controlPlaneBaseURL, mobileClientVersion } from "../config";
import { deviceLink, mobileSecurity } from "../native/mobileNative";
import type {
  DeviceIdentity,
  DeviceLinkPathScope,
  DevicePairing,
  DevicePairingChallenge,
  UserDevice
} from "./mobileDomain";
export type { DevicePairing, UserDevice } from "./mobileDomain";
import { accountCookie, readJSON } from "./http";
import {
  base64URLToStandard,
  deviceLinkProof,
  identityProof,
  pairingClaimProof,
  standardBase64ToURL,
  type PairingQRPayload
} from "./pairingProtocol";
import { PAIRING_OPERATION_SUSPENDED } from "./servicePorts";

interface RegisteredDevice {
  userDeviceId: string;
}

interface PairingChallenge extends DevicePairingChallenge {
  pairingId?: string;
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

export interface AgentRelayDescriptor {
  authorityId: string;
  relayDialEndpoint: string;
  token: string;
  tokenExpiresAt: string;
}

const RELAY_STREAM_SUBPROTOCOL = "tsh.relay.stream.v1";

export async function claimPairing(
  sessionId: string,
  payload: PairingQRPayload,
  isCurrent: () => boolean = () => true
): Promise<PairingChallenge> {
  const identity = await mobileSecurity.getOrCreateIdentity();
  requireCurrentPairing(isCurrent);
  await registerIdentity(sessionId, identity);
  requireCurrentPairing(isCurrent);
  const signature = await mobileSecurity.sign(
    pairingClaimProof(payload.challengeId, payload.secret)
  );
  requireCurrentPairing(isCurrent);
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

function requireCurrentPairing(isCurrent: () => boolean): void {
  if (isCurrent()) return;
  throw Object.assign(new Error("pairing operation was suspended"), {
    code: PAIRING_OPERATION_SUSPENDED
  });
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
  pairingId: string,
  isCurrent: () => boolean = () => true
): Promise<DeviceLinkPathScope> {
  const identity = await mobileSecurity.getOrCreateIdentity();
  await requireCurrentConnection(isCurrent);
  await registerIdentity(sessionId, identity);
  await requireCurrentConnection(isCurrent);
  const relayDescriptorTask = issueAgentRelayDescriptor(
    sessionId,
    pairingId,
    identity
  )
    .then(async (descriptor) => {
      if (!isCurrent() || typeof deviceLink.configureRelay !== "function") {
        return null;
      }
      await deviceLink.configureRelay(
        descriptor.relayDialEndpoint,
        JSON.stringify({
          authority_id: [descriptor.authorityId],
          channel: ["agent"],
          target: ["device-gateway"]
        }),
        JSON.stringify({
          Authorization: [`Bearer ${descriptor.token}`]
        }),
        RELAY_STREAM_SUBPROTOCOL
      );
      return isCurrent() ? descriptor : null;
    })
    .catch(() => null);
  try {
    let prepared = await deviceLink.prepareLink("[]", 10_000);
    let local = parseDeviceLinkDescription(prepared.descriptionJSON);
    await requireCurrentConnection(isCurrent);
    let attempt = await createDeviceLinkAttempt(
      sessionId,
      identity.deviceId,
      pairingId,
      local
    );
    await requireCurrentConnection(isCurrent);
    if ((attempt.stunEndpoints?.length ?? 0) > 0) {
      prepared = await deviceLink.prepareLink(
        JSON.stringify(attempt.stunEndpoints),
        10_000
      );
      local = parseDeviceLinkDescription(prepared.descriptionJSON);
      await requireCurrentConnection(isCurrent);
      attempt = await updateDeviceLinkParticipant(
        sessionId,
        identity.deviceId,
        pairingId,
        attempt.attemptId,
        local
      );
      await requireCurrentConnection(isCurrent);
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
        const scope = await deviceLink.connectLink(
          JSON.stringify({
            candidates: attempt.ownerIce.candidates,
            fingerprint: attempt.ownerFingerprint,
            pwd: attempt.ownerIce.pwd,
            ufrag: attempt.ownerIce.ufrag
          }),
          true,
          prepared.token,
          30_000
        );
        await requireCurrentConnection(isCurrent);
        return normalizeDeviceLinkPathScope(scope);
      }
      await delay(500);
      await requireCurrentConnection(isCurrent);
      attempt = await getDeviceLinkAttempt(
        sessionId,
        identity.deviceId,
        pairingId,
        attempt.attemptId,
        getSignature
      );
      await requireCurrentConnection(isCurrent);
    }
    if (await relayDescriptorTask) {
      await requireCurrentConnection(isCurrent);
      return "private_network";
    }
    throw new Error("device-link attempt expired");
  } catch (error) {
    if (isCurrent()) {
      await deviceLink.closeLink().catch(() => undefined);
    }
    throw error;
  }
}

export async function issueAgentRelayDescriptor(
  sessionId: string,
  pairingId: string,
  identity?: DeviceIdentity
): Promise<AgentRelayDescriptor> {
  const currentIdentity =
    identity ?? (await mobileSecurity.getOrCreateIdentity());
  const signature = await mobileSecurity.sign(
    deviceLinkProof("relay", pairingId, "", "")
  );
  const response = await controlPlaneRequest<{
    descriptor?: AgentRelayDescriptor;
    relayDialEndpoint?: string;
    authorityId?: string;
    token?: string;
    tokenExpiresAt?: string;
  }>(
    sessionId,
    `/device-pairings/${encodeURIComponent(pairingId)}/agent-relay-descriptor`,
    {
      body: JSON.stringify({
        deviceId: currentIdentity.deviceId,
        identitySignature: signature,
        pairingId
      }),
      method: "POST"
    }
  );
  const descriptor = response.descriptor ?? response;
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    typeof descriptor.authorityId !== "string" ||
    descriptor.authorityId.trim() === "" ||
    typeof descriptor.relayDialEndpoint !== "string" ||
    !/^wss?:\/\/[^\s/]+/i.test(descriptor.relayDialEndpoint.trim()) ||
    typeof descriptor.token !== "string" ||
    descriptor.token.trim() === "" ||
    typeof descriptor.tokenExpiresAt !== "string" ||
    Number.isNaN(Date.parse(descriptor.tokenExpiresAt))
  ) {
    throw new Error("control-plane Relay descriptor is incomplete");
  }
  return {
    authorityId: descriptor.authorityId.trim(),
    relayDialEndpoint: descriptor.relayDialEndpoint.trim(),
    token: descriptor.token.trim(),
    tokenExpiresAt: descriptor.tokenExpiresAt
  };
}

function normalizeDeviceLinkPathScope(scope: string): DeviceLinkPathScope {
  return scope === "local_subnet" || scope === "public_internet"
    ? scope
    : "private_network";
}

export async function registerCurrentDevice(
  sessionId: string
): Promise<RegisteredDevice> {
  const identity = await mobileSecurity.getOrCreateIdentity();
  return registerIdentity(sessionId, identity);
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
): Promise<RegisteredDevice> {
  const proof = await mobileSecurity.sign(
    identityProof(identity.deviceId, identity.publicKey)
  );
  const response = await controlPlaneRequest<{ device: RegisteredDevice }>(
    sessionId,
    "/devices/current",
    {
      body: JSON.stringify({
        arch: identity.arch,
        clientVersion: mobileClientVersion,
        deviceId: identity.deviceId,
        platform: Platform.OS,
        publicIdentity: {
          algorithm: "ed25519",
          proof,
          publicKey: base64URLToStandard(identity.publicKey)
        },
        reportedName: identity.deviceName
      }),
      method: "PUT"
    }
  );
  if (!response.device?.userDeviceId) {
    throw new Error("registered mobile device is incomplete");
  }
  return response.device;
}

async function requireCurrentConnection(
  isCurrent: () => boolean
): Promise<void> {
  if (isCurrent()) {
    return;
  }
  throw new Error("device-link connection was cancelled");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function controlPlaneRequest<T>(
  sessionId: string,
  path: string,
  init: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${controlPlaneBaseURL}${path}`, {
      ...init,
      credentials: "omit",
      headers: {
        Accept: "application/json",
        Cookie: accountCookie(sessionId),
        ...(init.body ? { "Content-Type": "application/json" } : {})
      },
      signal: controller.signal
    });
    return readJSON<T>(response);
  } finally {
    clearTimeout(timer);
  }
}
