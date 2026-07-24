export interface PairingQRPayload {
  challengeId: string;
  secret: string;
  version: 1;
}

export function parsePairingQR(raw: string): PairingQRPayload {
  const parsed = JSON.parse(raw) as Partial<PairingQRPayload>;
  if (
    parsed.version !== 1 ||
    typeof parsed.challengeId !== "string" ||
    parsed.challengeId.trim() === "" ||
    typeof parsed.secret !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(parsed.secret)
  ) {
    throw new Error("invalid pairing QR payload");
  }
  return {
    challengeId: parsed.challengeId.trim(),
    secret: parsed.secret,
    version: 1
  };
}

export function identityProof(deviceID: string, publicKey: string): string {
  return `tutti-device-identity/1\nregister\n${deviceID.trim()}\ned25519\n${publicKey}`;
}

export function pairingClaimProof(challengeID: string, secret: string): string {
  return `tutti-device-pairing/1\nclaim\n${challengeID.trim()}\n${secret}`;
}

export function deviceLinkProof(
  action: "create" | "get" | "update",
  pairingID: string,
  attemptID: string,
  fingerprint: string
): string {
  return `tutti-device-link/1\n${action}\n${pairingID.trim()}\n${attemptID.trim()}\n${fingerprint.trim()}`;
}

export function base64URLToStandard(value: string): string {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  return standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
}

export function standardBase64ToURL(value: string): string {
  return value.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
