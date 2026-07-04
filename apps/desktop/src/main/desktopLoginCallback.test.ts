import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  completeDesktopLoginCallbackUrl,
  findDesktopLoginCallbackUrl
} from "./desktopLoginCallback.ts";

function encodeState(input: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(input), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

test("finds login callback URL in second instance argv", () => {
  assert.equal(
    findDesktopLoginCallbackUrl(
      ["--flag", "tutti-dev://login/callback?state=s"],
      "tutti-dev://login/callback"
    ),
    "tutti-dev://login/callback?state=s"
  );
});

test("posts transfer code from deep link to local bridge completion endpoint", async () => {
  let receivedBody: unknown;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/oauth/complete");
    assert.equal(req.method, "POST");
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      receivedBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.ok(address);
    if (typeof address === "string") {
      throw new Error("expected tcp server address");
    }
    const state = encodeState({
      localServerOrigin: `http://127.0.0.1:${address.port}`
    });

    const completed = await completeDesktopLoginCallbackUrl(
      `tutti-dev://login/callback?state=${state}&transfer_code=transfer-1`
    );

    assert.equal(completed, true);
    assert.deepEqual(receivedBody, {
      transfer_code: "transfer-1",
      error: null,
      state
    });
  } finally {
    server.close();
  }
});
