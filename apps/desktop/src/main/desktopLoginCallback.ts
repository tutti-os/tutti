type BridgeState = {
  localServerOrigin?: string;
};

export function findDesktopLoginCallbackUrl(
  values: readonly string[],
  loginCallbackUrl: string
): string | null {
  return values.find((value) => value.startsWith(loginCallbackUrl)) ?? null;
}

export async function completeDesktopLoginCallbackUrl(
  rawUrl: string
): Promise<boolean> {
  const callbackUrl = new URL(rawUrl);
  const state = callbackUrl.searchParams.get("state")?.trim();
  const transferCode = callbackUrl.searchParams.get("transfer_code")?.trim();
  const error = callbackUrl.searchParams.get("error")?.trim();
  if (!state || (!transferCode && !error)) {
    return false;
  }

  const localServerOrigin = decodeBridgeState(state)?.localServerOrigin;
  if (!isAllowedLocalServerOrigin(localServerOrigin)) {
    return false;
  }

  const requestUrl = new URL("/oauth/complete", localServerOrigin);
  // oxlint-disable-next-line no-restricted-globals -- posts to the local login-bridge origin, not outbound
  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      transfer_code: transferCode || null,
      error: error || null,
      state
    })
  });
  return response.ok;
}

function decodeBridgeState(raw: string): BridgeState | null {
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(
      padded.padEnd(Math.ceil(padded.length / 4) * 4, "="),
      "base64"
    ).toString("utf8");
    return JSON.parse(json) as BridgeState;
  } catch {
    return null;
  }
}

function isAllowedLocalServerOrigin(
  value: string | undefined
): value is string {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port !== ""
    );
  } catch {
    return false;
  }
}
