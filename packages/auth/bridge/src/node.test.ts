import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTuttiNodeAuthClient, readAuthJson, writeAuthJson } from "./node";
import { DEFAULT_APP_ID } from "./shared";

test("auth json read/write keeps desktop-compatible shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutti-auth-bridge-"));
  const file = join(dir, "auth.json");
  try {
    await writeAuthJson(file, {
      sessionId: "session-1",
      cookie: "session_id=session-1",
      userId: "user-1",
      name: "Alice",
      avatar: "https://example.com/a.png",
      email: "alice@example.com",
      updatedAt: 123
    });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      session_id: "session-1",
      cookie: "session_id=session-1",
      user_id: "user-1",
      name: "Alice",
      avatar: "https://example.com/a.png",
      email: "alice@example.com",
      updatedAt: 123
    });
    assert.equal((await readAuthJson(file))?.sessionId, "session-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node login completes bridge, redeems transfer code, writes auth json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutti-auth-bridge-"));
  const file = join(dir, "auth.json");
  const accountServer = await startAccountStub();
  try {
    const authBase = `http://127.0.0.1:${accountServer.port}`;
    const auth = createTuttiNodeAuthClient({
      authJsonPath: file,
      appCallbackUrl: "tutti://auth/login",
      accountBaseUrl: authBase,
      accountHeaders: {
        "x-zk-ppe-lane": "lane-1",
        accept: "text/plain",
        "Content-TYPE": "text/plain",
        cookie: "session_id=attacker"
      },
      authLoginUrl: `${authBase}/auth/login`,
      openUrl: async (loginUrl) => {
        const state = new URL(loginUrl).searchParams.get("state") ?? "";
        const decoded = decodeState(state);
        const healthUrl = new URL("/oauth/health", decoded.localServerOrigin);
        healthUrl.searchParams.set("attempt_id", decoded.attemptId);
        healthUrl.searchParams.set("token", decoded.bridgeToken);
        const healthResponse = await fetch(healthUrl);
        assert.equal(healthResponse.ok, true);
        assert.equal(
          healthResponse.headers.get("Access-Control-Allow-Private-Network"),
          "true"
        );
        const completeResponse = await fetch(
          new URL("/oauth/complete", decoded.localServerOrigin),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: authBase
            },
            body: JSON.stringify({ state, transfer_code: "transfer-1" })
          }
        );
        assert.equal(completeResponse.ok, true);
      }
    });

    const result = await auth.login();
    assert.equal(result.session.sessionId, "desktop-session-1");
    assert.deepEqual(result.user, {
      userId: "user-1",
      name: "Alice",
      email: "alice@example.com",
      avatar: undefined
    });
    assert.equal(
      (await readAuthJson(file))?.cookie,
      "session_id=desktop-session-1"
    );
    assert.deepEqual(accountServer.requests.redeem, {
      transfer_code: "transfer-1",
      attempt_id: accountServer.requests.redeem?.attempt_id,
      bridge_token: accountServer.requests.redeem?.bridge_token,
      app_id: DEFAULT_APP_ID,
      device_id: accountServer.requests.redeem?.device_id
    });
    assert.equal(accountServer.requests.headers.redeem, "lane-1");
    assert.equal(accountServer.requests.headers.userInfo, "lane-1");
  } finally {
    await accountServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("node login callback redirects to web result after writing auth json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutti-auth-bridge-"));
  const file = join(dir, "auth.json");
  const accountServer = await startAccountStub();
  try {
    const authBase = `http://127.0.0.1:${accountServer.port}`;
    const auth = createTuttiNodeAuthClient({
      authJsonPath: file,
      appCallbackUrl: "tutti://auth/login?transfer_code=bad",
      accountBaseUrl: authBase,
      authLoginUrl: `${authBase}/auth/login`,
      openUrl: async (loginUrl) => {
        const state = new URL(loginUrl).searchParams.get("state") ?? "";
        const decoded = decodeState(state);
        const callbackUrl = new URL(
          "/oauth/callback",
          decoded.localServerOrigin
        );
        callbackUrl.searchParams.set("state", state);
        callbackUrl.searchParams.set("transfer_code", "transfer-1");
        const callbackResponse = await fetch(callbackUrl, {
          redirect: "manual"
        });
        assert.equal(callbackResponse.status, 302);
        const location = callbackResponse.headers.get("location") ?? "";
        assert.equal(location.includes("transfer-1"), false);
        const resultUrl = new URL(location);
        assert.equal(
          resultUrl.searchParams.get("desktopBridgeStatus"),
          "success"
        );
        const openAppUrl = resultUrl.searchParams.get("openAppUrl") ?? "";
        assert.equal(openAppUrl.includes("transfer_code"), false);
        assert.equal(new URL(openAppUrl).protocol, "tutti:");
      }
    });

    const result = await auth.login();
    assert.equal(result.session.sessionId, "desktop-session-1");
    assert.equal(
      (await readAuthJson(file))?.cookie,
      "session_id=desktop-session-1"
    );
    assert.deepEqual(accountServer.requests.redeem, {
      transfer_code: "transfer-1",
      attempt_id: accountServer.requests.redeem?.attempt_id,
      bridge_token: accountServer.requests.redeem?.bridge_token,
      app_id: DEFAULT_APP_ID,
      device_id: accountServer.requests.redeem?.device_id
    });
  } finally {
    await accountServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("node login completes when another bridge connection is stalled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutti-auth-bridge-"));
  const file = join(dir, "auth.json");
  const accountServer = await startAccountStub();
  let stalledSocket: Socket | undefined;
  let stalledSocketClosed: Promise<void> | undefined;
  try {
    const authBase = `http://127.0.0.1:${accountServer.port}`;
    const auth = createTuttiNodeAuthClient({
      authJsonPath: file,
      appCallbackUrl: "tutti://auth/login",
      accountBaseUrl: authBase,
      authLoginUrl: `${authBase}/auth/login`,
      openUrl: async (loginUrl) => {
        const state = new URL(loginUrl).searchParams.get("state") ?? "";
        const bridgeUrl = new URL(decodeState(state).localServerOrigin ?? "");
        stalledSocket = createConnection({
          host: bridgeUrl.hostname,
          port: Number(bridgeUrl.port)
        });
        stalledSocketClosed = new Promise<void>((resolve) => {
          stalledSocket?.once("close", resolve);
        });
        await new Promise<void>((resolve, reject) => {
          stalledSocket?.once("connect", resolve);
          stalledSocket?.once("error", reject);
        });
        stalledSocket.write(
          `GET /oauth/health HTTP/1.1\r\nHost: ${bridgeUrl.host}\r\n`
        );

        const callbackUrl = new URL("/oauth/callback", bridgeUrl);
        callbackUrl.searchParams.set("state", state);
        callbackUrl.searchParams.set("transfer_code", "transfer-1");
        const callbackResponse = await fetch(callbackUrl, {
          redirect: "manual"
        });
        assert.equal(callbackResponse.status, 302);
        assert.equal(callbackResponse.headers.get("connection"), "close");
      }
    });

    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      auth.login(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("login did not close the bridge in time")),
          2_500
        );
      })
    ]).finally(() => clearTimeout(timeout));
    assert.equal(result.session.sessionId, "desktop-session-1");
    let socketCloseTimeout: NodeJS.Timeout | undefined;
    await Promise.race([
      stalledSocketClosed,
      new Promise<never>((_, reject) => {
        socketCloseTimeout = setTimeout(
          () =>
            reject(
              new Error("stalled bridge connection did not close in time")
            ),
          2_500
        );
      })
    ]).finally(() => clearTimeout(socketCloseTimeout));
  } finally {
    stalledSocket?.destroy();
    await accountServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("node bridge rejects invalid callback state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutti-auth-bridge-"));
  const file = join(dir, "auth.json");
  const accountServer = await startAccountStub();
  try {
    const authBase = `http://127.0.0.1:${accountServer.port}`;
    const auth = createTuttiNodeAuthClient({
      authJsonPath: file,
      appCallbackUrl: "tutti://auth/login",
      accountBaseUrl: authBase,
      authLoginUrl: `${authBase}/auth/login`,
      loginMaxTimeoutMs: 20,
      openUrl: async (loginUrl) => {
        const state = new URL(loginUrl).searchParams.get("state") ?? "";
        const decoded = decodeState(state);
        const response = await fetch(
          new URL("/oauth/complete", decoded.localServerOrigin),
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: authBase
            },
            body: JSON.stringify({
              state: mutateState(state),
              transfer_code: "transfer-1"
            })
          }
        );
        assert.equal(response.status, 400);
      }
    });

    await assert.rejects(auth.login(), /Invalid state|Login timed out/u);
  } finally {
    await accountServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("node getUserInfo refreshes auth json and logout clears it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tutti-auth-bridge-"));
  const file = join(dir, "auth.json");
  const accountServer = await startAccountStub();
  try {
    await writeAuthJson(file, {
      sessionId: "desktop-session-1",
      cookie: "session_id=desktop-session-1",
      userId: "old-user",
      name: "",
      avatar: "",
      email: "",
      updatedAt: 1
    });
    const auth = createTuttiNodeAuthClient({
      authJsonPath: file,
      appCallbackUrl: "tutti://auth/login",
      accountBaseUrl: `http://127.0.0.1:${accountServer.port}`,
      accountHeaders: {
        "x-zk-ppe-lane": "lane-1",
        accept: "text/plain",
        "Content-TYPE": "text/plain",
        cookie: "session_id=attacker"
      }
    });
    assert.deepEqual(await auth.getUserInfo(), {
      userId: "user-1",
      name: "Alice",
      email: "alice@example.com",
      avatar: undefined
    });
    assert.equal((await readAuthJson(file))?.userId, "user-1");
    await auth.logout();
    assert.equal(await readAuthJson(file), null);
    assert.equal(accountServer.requests.logout?.app_id, DEFAULT_APP_ID);
    assert.equal(accountServer.requests.headers.userInfo, "lane-1");
    assert.equal(accountServer.requests.headers.logout, "lane-1");
  } finally {
    await accountServer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function decodeState(state: string): Record<string, string> {
  return JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as Record<
    string,
    string
  >;
}

function mutateState(state: string): string {
  const decoded = decodeState(state);
  decoded.attemptId = "wrong-attempt";
  return Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
}

async function startAccountStub(): Promise<{
  port: number;
  requests: {
    redeem?: Record<string, string>;
    logout?: Record<string, string>;
    headers: {
      redeem?: string;
      userInfo?: string;
      logout?: string;
    };
  };
  close: () => Promise<void>;
}> {
  const requests: {
    redeem?: Record<string, string>;
    logout?: Record<string, string>;
    headers: {
      redeem?: string;
      userInfo?: string;
      logout?: string;
    };
  } = { headers: {} };
  const server = createServer(async (req, res) => {
    if (req.url === "/auth/v1/redeem_desktop_transfer_code") {
      assert.equal(req.headers.accept, "application/json");
      assert.equal(req.headers["content-type"], "application/json");
      assert.equal(req.headers.cookie, undefined);
      requests.headers.redeem = req.headers["x-zk-ppe-lane"] as
        | string
        | undefined;
      requests.redeem = (await readBody(req)) as Record<string, string>;
      sendJson(res, { code: 0, data: { session_id: "desktop-session-1" } });
      return;
    }
    if (req.url === "/user/v1/user_info") {
      assert.equal(req.headers.accept, "application/json");
      assert.equal(req.headers["content-type"], "application/json");
      requests.headers.userInfo = req.headers["x-zk-ppe-lane"] as
        | string
        | undefined;
      assert.equal(req.headers.cookie, "session_id=desktop-session-1");
      sendJson(res, {
        code: 0,
        data: { user_id: "user-1", name: "Alice", email: "alice@example.com" }
      });
      return;
    }
    if (req.url === "/auth/v1/logout-web-session") {
      assert.equal(req.headers.accept, "application/json");
      assert.equal(req.headers["content-type"], "application/json");
      requests.headers.logout = req.headers["x-zk-ppe-lane"] as
        | string
        | undefined;
      requests.logout = (await readBody(req)) as Record<string, string>;
      assert.equal(req.headers.cookie, "session_id=desktop-session-1");
      sendJson(res, { code: 0 });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await listen(server);
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  return {
    port: address.port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
