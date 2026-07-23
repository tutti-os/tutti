import {
  deviceLinkProof,
  identityProof,
  pairingClaimProof,
  parsePairingQR,
  standardBase64ToURL
} from "./pairingProtocol";

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
