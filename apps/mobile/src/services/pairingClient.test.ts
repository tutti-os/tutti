jest.mock("../native/mobileNative", () => ({
  __esModule: true,
  deviceLink: {
    closeLink: jest.fn(),
    configureRelay: jest.fn(),
    connectLink: jest.fn(),
    prepareLink: jest.fn(),
    probeRelay: jest.fn()
  },
  mobileSecurity: {
    getOrCreateIdentity: jest.fn(),
    sign: jest.fn()
  }
}));

import { deviceLink, mobileSecurity } from "../native/mobileNative";
import {
  claimPairing,
  connectPairedDevice,
  issueAgentRelayDescriptor,
  registerCurrentDevice
} from "./pairingClient";
import {
  deviceLinkProof,
  identityProof,
  pairingClaimProof,
  parsePairingQR,
  standardBase64ToURL
} from "./pairingProtocol";
import { PAIRING_OPERATION_SUSPENDED } from "./servicePorts";

const mockGetOrCreateIdentity = jest.mocked(mobileSecurity.getOrCreateIdentity);
const mockSign = jest.mocked(mobileSecurity.sign);
const mockCloseLink = jest.mocked(deviceLink.closeLink);
const mockConfigureRelay = jest.mocked(deviceLink.configureRelay!);
const mockConnectLink = jest.mocked(deviceLink.connectLink);
const mockPrepareLink = jest.mocked(deviceLink.prepareLink);
const mockProbeRelay = jest.mocked(deviceLink.probeRelay);

function controlPlaneResponse(data: unknown): Response {
  return {
    json: async () => data,
    ok: true,
    status: 200
  } as Response;
}

describe("control-plane authentication", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("uses only the explicit session cookie", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    mockSign.mockResolvedValue("proof-1");
    const fetchMock = jest.fn().mockResolvedValue(
      controlPlaneResponse({
        device: { userDeviceId: "user-device-1" }
      })
    );
    globalThis.fetch = fetchMock;

    await expect(registerCurrentDevice("session-1")).resolves.toEqual({
      userDeviceId: "user-device-1"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://tutti.sh/api/desktop/v1/devices/current",
      expect.objectContaining({
        credentials: "omit",
        headers: expect.objectContaining({
          Cookie: "session_id=session-1"
        }),
        method: "PUT"
      })
    );
  });

  it("does not send a claim after the operation is suspended", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    await expect(
      claimPairing(
        "session-1",
        {
          challengeId: "challenge-1",
          secret: "a".repeat(43),
          version: 1
        },
        () => false
      )
    ).rejects.toMatchObject({ code: PAIRING_OPERATION_SUSPENDED });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests a scoped Agent Relay descriptor with the relay proof", async () => {
    mockSign.mockResolvedValue("relay-signature");
    const fetchMock = jest.fn().mockResolvedValue(
      controlPlaneResponse({
        authorityId: "authority-1",
        relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
        token: "target-token",
        tokenExpiresAt: "2026-08-04T10:00:00Z"
      })
    );
    globalThis.fetch = fetchMock;

    await expect(
      issueAgentRelayDescriptor("session-1", "pairing-1", {
        arch: "arm64",
        deviceId: "device-1",
        deviceName: "Alice's iPhone",
        publicKey: "cHVibGljLWtleQ"
      })
    ).resolves.toEqual({
      authorityId: "authority-1",
      relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
      token: "target-token",
      tokenExpiresAt: "2026-08-04T10:00:00Z"
    });

    expect(mockSign).toHaveBeenCalledWith(
      deviceLinkProof("relay", "pairing-1", "", "")
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tutti.sh/api/desktop/v1/device-pairings/pairing-1/agent-relay-descriptor",
      expect.objectContaining({
        body: JSON.stringify({
          deviceId: "device-1",
          identitySignature: "relay-signature",
          pairingId: "pairing-1"
        }),
        headers: expect.objectContaining({
          Cookie: "session_id=session-1"
        }),
        method: "POST"
      })
    );
  });

  it("rejects a Relay descriptor that is not a websocket endpoint", async () => {
    mockSign.mockResolvedValue("relay-signature");
    globalThis.fetch = jest.fn().mockResolvedValue(
      controlPlaneResponse({
        authorityId: "authority-1",
        relayDialEndpoint: "https://relay.example.test/not-websocket",
        token: "target-token",
        tokenExpiresAt: "2026-08-04T10:00:00Z"
      })
    );

    await expect(
      issueAgentRelayDescriptor("session-1", "pairing-1", {
        arch: "arm64",
        deviceId: "device-1",
        deviceName: "Alice's iPhone",
        publicKey: "cHVibGljLWtleQ"
      })
    ).rejects.toThrow("control-plane Relay descriptor is incomplete");
  });

  it("returns the existing path scope while Relay is ready first", async () => {
    mockGetOrCreateIdentity.mockResolvedValue({
      arch: "arm64",
      deviceId: "device-1",
      deviceName: "Alice's iPhone",
      publicKey: "cHVibGljLWtleQ"
    });
    mockSign.mockResolvedValue("signature");
    let resolvePrepareLink!: (value: {
      descriptionJSON: string;
      token: number;
    }) => void;
    mockPrepareLink.mockReturnValue(
      new Promise((resolve) => {
        resolvePrepareLink = resolve;
      })
    );
    mockConfigureRelay.mockResolvedValue(undefined);
    let resolveProbeRelay!: () => void;
    mockProbeRelay.mockReturnValue(
      new Promise((resolve) => {
        resolveProbeRelay = resolve;
      })
    );
    mockConnectLink.mockResolvedValue("local_subnet");
    globalThis.fetch = jest.fn().mockImplementation((input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/devices/current")) {
        return Promise.resolve(
          controlPlaneResponse({ device: { userDeviceId: "user-device-1" } })
        );
      }
      if (url.includes("/agent-relay-descriptor")) {
        return Promise.resolve(
          controlPlaneResponse({
            authorityId: "authority-1",
            relayDialEndpoint: "wss://relay.example.test/v1/tunnels/dial",
            token: "target-token",
            tokenExpiresAt: "2026-08-04T10:00:00Z"
          })
        );
      }
      if (url.includes("/device-link-attempts")) {
        return Promise.resolve(
          controlPlaneResponse({
            attempt: {
              attemptId: "attempt-1",
              callerFingerprint: "fingerprint-1",
              callerIce: {
                candidates: ["candidate:local"],
                pwd: "password",
                ufrag: "username"
              },
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
              ownerFingerprint: "owner-fingerprint-1",
              ownerIce: {
                candidates: ["candidate:owner"],
                pwd: "owner-password",
                ufrag: "owner-username"
              },
              state: "ready"
            }
          })
        );
      }
      throw new Error(`unexpected control-plane request: ${url}`);
    });

    let settled = false;
    const connection = connectPairedDevice("session-1", "pairing-1").then(
      (scope) => {
        settled = true;
        return scope;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(mockConfigureRelay).toHaveBeenCalledTimes(1);
    expect(mockProbeRelay).toHaveBeenCalledWith(10_000);
    expect(mockConnectLink).not.toHaveBeenCalled();
    expect(mockCloseLink).not.toHaveBeenCalled();

    resolveProbeRelay();
    await expect(connection).resolves.toBe("private_network");

    resolvePrepareLink({
      descriptionJSON: JSON.stringify({
        candidates: ["candidate:local"],
        fingerprint: "fingerprint-1",
        pwd: "password",
        ufrag: "username"
      }),
      token: 1
    });
    for (
      let attempt = 0;
      attempt < 20 && !mockConnectLink.mock.calls.length;
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(mockConnectLink).toHaveBeenCalledTimes(1);
  });
});

describe("parsePairingQR", () => {
  it("accepts the canonical version one payload", () => {
    const secret = "a".repeat(43);
    expect(
      parsePairingQR(
        JSON.stringify({
          challengeId: "challenge-1",
          secret,
          version: 1
        })
      )
    ).toEqual({
      challengeId: "challenge-1",
      secret,
      version: 1
    });
  });

  it.each([
    "{}",
    '{"version":2,"challengeId":"challenge-1","secret":"x"}',
    '{"version":1,"challengeId":"","secret":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    '{"version":1,"challengeId":"challenge-1","secret":"not canonical"}'
  ])("rejects an invalid payload: %s", (payload) => {
    expect(() => parsePairingQR(payload)).toThrow("invalid pairing QR payload");
  });
});

describe("pairing proofs", () => {
  it("uses the server canonical byte layout", () => {
    expect(identityProof(" device-1 ", "public-key")).toBe(
      "tutti-device-identity/1\nregister\ndevice-1\ned25519\npublic-key"
    );
    expect(pairingClaimProof(" challenge-1 ", "secret")).toBe(
      "tutti-device-pairing/1\nclaim\nchallenge-1\nsecret"
    );
    expect(deviceLinkProof("create", " pairing-1 ", "", " fingerprint ")).toBe(
      "tutti-device-link/1\ncreate\npairing-1\n\nfingerprint"
    );
    expect(deviceLinkProof("get", "pairing-1", "attempt-1", "")).toBe(
      "tutti-device-link/1\nget\npairing-1\nattempt-1\n"
    );
    expect(deviceLinkProof("relay", "pairing-1", "", "")).toBe(
      "tutti-device-link/1\nrelay\npairing-1\n\n"
    );
    expect(standardBase64ToURL("a+b/c==")).toBe("a-b_c");
  });
});
