import { createHmac } from "node:crypto";
import type { DesktopDaemonEndpoint } from "../transport/paths";
import type { WorkspaceAppGuestContext } from "./workspaceAppContextTypes.ts";

export function createWorkspaceAppContextToken(
  endpoint: DesktopDaemonEndpoint,
  context: WorkspaceAppGuestContext,
  input: { installationId: string; issuer: string }
): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    appId: context.appID,
    aud: context.appID,
    exp: nowSeconds + 5 * 60,
    iat: nowSeconds,
    installationId: input.installationId,
    iss: input.issuer,
    workspaceId: context.workspaceID
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const appToken = createAppServerToken(
    endpoint.accessToken,
    context.workspaceID,
    context.appID
  );
  const signature = createHmac("sha256", appToken)
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

export function createAppServerToken(
  accessToken: string,
  workspaceID: string,
  appID: string
): string {
  const mac = createHmac("sha256", accessToken.trim());
  mac.update(workspaceID.trim());
  mac.update(Buffer.from([0]));
  mac.update(appID.trim());
  return `tutti-app-v1.${mac.digest("base64url")}`;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
