jest.mock("../native/mobileNative", () => ({
  __esModule: true,
  deviceLink: {},
  mobileSecurity: {
    getOrCreateIdentity: jest.fn(),
    sign: jest.fn()
  }
}));

import { mobileSecurity } from "../native/mobileNative";
import { claimPairing, registerCurrentDevice } from "./pairingClient";
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
    expect(standardBase64ToURL("a+b/c==")).toBe("a-b_c");
  });
});
