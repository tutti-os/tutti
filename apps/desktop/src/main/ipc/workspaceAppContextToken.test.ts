import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createAppServerToken,
  createWorkspaceAppContextToken
} from "./workspaceAppContextToken.ts";

test("workspace app server token trims scoped identifiers before signing", () => {
  const expected = createHmac("sha256", "access-token")
    .update("workspace-1")
    .update(Buffer.from([0]))
    .update("demo-app")
    .digest("base64url");

  assert.equal(
    createAppServerToken(" access-token ", " workspace-1 ", " demo-app "),
    `tutti-app-v1.${expected}`
  );
});

test("workspace app context token signs claims with the app server token", (t) => {
  t.mock.method(Date, "now", () => 1_749_124_800_000);
  const token = createWorkspaceAppContextToken(
    {
      accessToken: "access-token",
      boundAddr: "127.0.0.1:49217",
      listenerInfoPath: "",
      pidPath: "",
      requestedAddr: "127.0.0.1:0"
    },
    {
      appID: "demo-app",
      ownerWindow: {} as never,
      workspaceID: "workspace-1"
    },
    {
      installationId: "workspace-1:demo-app",
      issuer: "http://127.0.0.1:49217"
    }
  );
  const [encodedPayload, signature, unexpected] = token.split(".");
  assert.equal(unexpected, undefined);
  assert.ok(encodedPayload);
  assert.ok(signature);
  assert.deepEqual(
    JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
    {
      appId: "demo-app",
      aud: "demo-app",
      exp: 1_749_125_100,
      iat: 1_749_124_800,
      installationId: "workspace-1:demo-app",
      iss: "http://127.0.0.1:49217",
      workspaceId: "workspace-1"
    }
  );
  const appToken = createAppServerToken(
    "access-token",
    "workspace-1",
    "demo-app"
  );
  assert.equal(
    signature,
    createHmac("sha256", appToken).update(encodedPayload).digest("base64url")
  );
});
