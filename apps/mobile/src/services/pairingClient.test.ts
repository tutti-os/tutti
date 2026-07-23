import {
  identityProof,
  pairingClaimProof,
  parsePairingQR
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
  });
});
