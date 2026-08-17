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
import type { MobileDiagnosticsPort } from "./servicePorts";
import type { DeviceLinkAttemptEventSource } from "./deviceLinkAttemptEvents";
import {
  connectTrickledDeviceLink,
  parseDeviceLinkDescription,
  type DeviceLinkAttempt,
  type DeviceLinkDescription
} from "./deviceLinkCandidateExchange";
import { raceSuccessful } from "./pairingTransportRace";

interface RegisteredDevice {
  userDeviceId: string;
}

interface PairingChallenge extends DevicePairingChallenge {
  pairingId?: string;
}

export interface AgentRelayDescriptor {
  authorityId: string;
  relayDialEndpoint: string;
  token: string;
  tokenExpiresAt: string;
}

const RELAY_STREAM_SUBPROTOCOL = "tsh.relay.stream.v1";

export interface PairedDeviceConnectionOptions {
  attemptEvents?: DeviceLinkAttemptEventSource;
  diagnostics?: MobileDiagnosticsPort;
}

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
  isCurrent: () => boolean = () => true,
  options: PairedDeviceConnectionOptions = {}
): Promise<DeviceLinkPathScope> {
  const identity = await mobileSecurity.getOrCreateIdentity();
  requireCurrentConnection(isCurrent);
  await registerIdentity(sessionId, identity);
  requireCurrentConnection(isCurrent);
  const relayController = new AbortController();
  const directController = new AbortController();
  const raceStartedAt = Date.now();
  let remoteCandidateWakeBinding:
    | { attemptId: string; token: number }
    | undefined;
  const attemptEvents = options.attemptEvents?.start(
    sessionId,
    identity.deviceId,
    (attemptId) => {
      const binding = remoteCandidateWakeBinding;
      if (binding?.attemptId === attemptId) {
        void deviceLink
          .notifyRemoteCandidateChange(binding.token)
          .catch(() => undefined);
      }
    }
  );
  const directTask = connectDirectDevice(
    sessionId,
    pairingId,
    identity,
    isCurrent,
    directController.signal,
    (attemptId, token) => {
      const binding = { attemptId, token };
      remoteCandidateWakeBinding = binding;
      return () => {
        if (remoteCandidateWakeBinding === binding) {
          remoteCandidateWakeBinding = undefined;
        }
      };
    },
    options.diagnostics
  ).finally(() => attemptEvents?.close());
  const relayTask = configureRelayTransport(
    sessionId,
    pairingId,
    identity,
    isCurrent,
    relayController.signal
  ).then(async (descriptor) => {
    if (descriptor === null) return null;
    recordDeviceLinkStage(
      options.diagnostics,
      "relay_descriptor_ready",
      raceStartedAt
    );
    // A descriptor only makes Relay dialable. The native probe opens a Relay
    // stream and waits for the paired desktop Agent endpoint to acknowledge a
    // authenticated Agent request before this path can win the connection race.
    requireCurrentConnection(isCurrent, relayController.signal);
    await deviceLink.probeRelay(10_000);
    requireCurrentConnection(isCurrent, relayController.signal);
    recordDeviceLinkStage(
      options.diagnostics,
      "relay_probe_ready",
      raceStartedAt
    );
    return descriptor;
  });
  try {
    const winner = await raceSuccessful<
      DeviceLinkPathScope | AgentRelayDescriptor
    >([
      {
        name: "direct",
        run: () => directTask
      },
      {
        name: "relay",
        run: async () => (await relayTask) ?? null
      }
    ]);
    requireCurrentConnection(isCurrent);
    if (winner.name === "relay") {
      // The Relay task completes only after the native Agent probe has
      // received a response from the paired desktop. Keep direct rendezvous
      // running so later data-stream races retain a direct candidate.
      return "private_network";
    }
    // Direct is already usable. Do not leave a control-plane descriptor
    // request running after the connection lifecycle has returned; a later
    // reconnect will request a fresh Relay descriptor if it needs one.
    relayController.abort();
    return winner.value as DeviceLinkPathScope;
  } catch (error) {
    relayController.abort();
    directController.abort();
    if (isCurrent()) {
      await deviceLink.closeLink().catch(() => undefined);
    }
    throw error;
  }
}

async function connectDirectDevice(
  sessionId: string,
  pairingId: string,
  identity: DeviceIdentity,
  isCurrent: () => boolean,
  signal: AbortSignal,
  bindRemoteCandidateWake: (attemptId: string, token: number) => () => void,
  diagnostics?: MobileDiagnosticsPort
): Promise<DeviceLinkPathScope> {
  const startedAt = Date.now();
  let prepared: { descriptionJSON: string; token: number } | undefined;
  try {
    prepared = await deviceLink.prepareLink("[]", 10_000);
    let local = parseDeviceLinkDescription(prepared.descriptionJSON);
    requireCurrentConnection(isCurrent, signal);
    let attempt = await createDeviceLinkAttempt(
      sessionId,
      identity.deviceId,
      pairingId,
      local,
      signal
    );
    requireCurrentConnection(isCurrent, signal);
    recordDeviceLinkStage(diagnostics, "direct_attempt_created", startedAt);
    if ((attempt.stunEndpoints?.length ?? 0) > 0) {
      prepared = await deviceLink.prepareLink(
        JSON.stringify(attempt.stunEndpoints),
        10_000
      );
      local = parseDeviceLinkDescription(prepared.descriptionJSON);
      requireCurrentConnection(isCurrent, signal);
      attempt = await updateDeviceLinkParticipant(
        sessionId,
        identity.deviceId,
        pairingId,
        attempt.attemptId,
        local,
        signal
      );
      requireCurrentConnection(isCurrent, signal);
    }
    recordDeviceLinkStage(diagnostics, "direct_credentials_ready", startedAt);
    const deadline = Date.parse(attempt.expiresAt);
    const getSignature = standardBase64ToURL(
      await mobileSecurity.sign(
        deviceLinkProof("get", pairingId, attempt.attemptId, "")
      )
    );
    const scope = await connectTrickledDeviceLink({
      attempt,
      bindRemoteCandidateWake,
      deadline,
      ensureCurrent: () => requireCurrentConnection(isCurrent, signal),
      fetchRemote: (actionSignal) =>
        getDeviceLinkAttempt(
          sessionId,
          identity.deviceId,
          pairingId,
          attempt.attemptId,
          getSignature,
          actionSignal
        ),
      local,
      publishLocal: (description, actionSignal) =>
        updateDeviceLinkParticipant(
          sessionId,
          identity.deviceId,
          pairingId,
          attempt.attemptId,
          description,
          actionSignal
        ),
      record: (stage) => recordDeviceLinkStage(diagnostics, stage, startedAt),
      signal,
      token: prepared.token
    });
    requireCurrentConnection(isCurrent, signal);
    recordDeviceLinkStage(diagnostics, "direct_connected", startedAt);
    return normalizeDeviceLinkPathScope(scope);
  } catch (error) {
    if (prepared) {
      await deviceLink
        .stopCandidateExchange(prepared.token)
        .catch(() => undefined);
      await deviceLink.cancelLink(prepared.token).catch(() => undefined);
    }
    throw error;
  }
}

async function configureRelayTransport(
  sessionId: string,
  pairingId: string,
  identity: DeviceIdentity,
  isCurrent: () => boolean,
  signal: AbortSignal
): Promise<AgentRelayDescriptor | null> {
  if (typeof deviceLink.configureRelay !== "function") {
    return null;
  }
  const descriptor = await issueAgentRelayDescriptor(
    sessionId,
    pairingId,
    identity,
    signal
  );
  requireCurrentConnection(isCurrent, signal);
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
  requireCurrentConnection(isCurrent, signal);
  return descriptor;
}

export async function issueAgentRelayDescriptor(
  sessionId: string,
  pairingId: string,
  identity?: DeviceIdentity,
  signal?: AbortSignal
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
    },
    signal
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
  local: DeviceLinkDescription,
  signal?: AbortSignal
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
    },
    signal
  );
  return response.attempt;
}

async function updateDeviceLinkParticipant(
  sessionId: string,
  deviceId: string,
  pairingId: string,
  attemptId: string,
  local: DeviceLinkDescription,
  signal?: AbortSignal
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
    },
    signal
  );
  return response.attempt;
}

async function getDeviceLinkAttempt(
  sessionId: string,
  deviceId: string,
  pairingId: string,
  attemptId: string,
  identitySignature: string,
  signal?: AbortSignal
): Promise<DeviceLinkAttempt> {
  const response = await controlPlaneRequest<{ attempt: DeviceLinkAttempt }>(
    sessionId,
    `/device-pairings/${encodeURIComponent(pairingId)}/device-link-attempts/${encodeURIComponent(attemptId)}?deviceId=${encodeURIComponent(deviceId)}&identitySignature=${encodeURIComponent(identitySignature)}`,
    { method: "GET" },
    signal
  );
  return response.attempt;
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

function requireCurrentConnection(
  isCurrent: () => boolean,
  signal?: AbortSignal
): void {
  if (signal?.aborted) {
    throw new Error("device-link connection race was cancelled");
  }
  if (isCurrent()) {
    return;
  }
  throw new Error("device-link connection was cancelled");
}

function recordDeviceLinkStage(
  diagnostics: MobileDiagnosticsPort | undefined,
  stage:
    | "direct_attempt_created"
    | "direct_attempt_ready"
    | "direct_credentials_ready"
    | "direct_connected"
    | "direct_first_candidate_published"
    | "direct_remote_candidate_received"
    | "relay_descriptor_ready"
    | "relay_probe_ready",
  startedAt: number
): void {
  diagnostics?.record({
    elapsedMs: Math.max(0, Date.now() - startedAt),
    name: "device_link.stage",
    stage
  });
}

async function controlPlaneRequest<T>(
  sessionId: string,
  path: string,
  init: RequestInit,
  externalSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const abortExternal = () => controller.abort();
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
  }
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
    externalSignal?.removeEventListener("abort", abortExternal);
  }
}
