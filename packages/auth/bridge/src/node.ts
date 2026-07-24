import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { hostname } from "node:os";
import { dirname } from "node:path";
import {
  buildBridgeResultUrl,
  callbackErrorToError,
  callbackErrorToSafeResultCode,
  isTuttiAuthUserCancelledError
} from "./node-login-result";
import {
  type AccountEnvelope,
  AUTH_SERVER_BASE_PORT,
  AUTH_SERVER_HOST,
  AUTH_SERVER_MAX_PORT,
  buildAccountUrl,
  buildSessionCookie,
  DEFAULT_ACCOUNT_BASE_URL,
  DEFAULT_APP_ID,
  DEFAULT_AUTH_LOGIN_URL,
  DEFAULT_LOGIN_IDLE_TIMEOUT_MS,
  DEFAULT_LOGIN_MAX_TIMEOUT_MS,
  mapUserInfo,
  readEnvelopeError,
  type TuttiAuthSession,
  type TuttiUserInfo,
  trimString
} from "./shared";

const BRIDGE_SERVER_FORCE_CLOSE_TIMEOUT_MS = 1_000;

export interface TuttiNodeAuthClientOptions {
  authJsonPath: string;
  appCallbackUrl: string;
  openUrl?: (url: string) => Promise<void> | void;
  appId?: string;
  accountBaseUrl?: string;
  authLoginUrl?: string;
  deviceId?: string;
  deviceName?: string;
  clientVersion?: string;
  hostname?: string;
  loginIdleTimeoutMs?: number;
  loginMaxTimeoutMs?: number;
  accountHeaders?: Readonly<Record<string, string>>;
}

export interface TuttiNodeAuthClient {
  login: () => Promise<{ session: TuttiAuthSession; user: TuttiUserInfo }>;
  getUserInfo: () => Promise<TuttiUserInfo | null>;
  logout: () => Promise<void>;
  readSession: () => Promise<TuttiAuthSession | null>;
  clearSession: () => Promise<void>;
}

type BridgeState = {
  v: number;
  flow: "desktop_bridge";
  attemptId: string;
  localServerOrigin: string;
  bridgeToken: string;
  appId: string;
  appCallbackUrl: string;
  deviceId?: string;
  deviceName?: string;
  clientVersion?: string;
  hostname?: string;
  provider?: string;
  nonce?: string;
};

type PendingLogin = {
  accountHeaders: Readonly<Record<string, string>>;
  accountBaseUrl: string;
  appId: string;
  appCallbackUrl: string;
  authJsonPath: string;
  attemptId: string;
  authOrigin: string;
  bridgeToken: string;
  completedResult?: { session: TuttiAuthSession; user: TuttiUserInfo };
  deviceId: string;
  localServerOrigin: string;
  state: string;
  expiresAt: number;
  maxExpiresAt: number;
  idleTimeoutMs: number;
  completed: boolean;
};

type BridgeServer = {
  server: Server;
  waitForCompletion: Promise<string>;
};

export function createTuttiNodeAuthClient(
  options: TuttiNodeAuthClientOptions
): TuttiNodeAuthClient {
  const authJsonPath = options.authJsonPath.trim();
  const appCallbackUrl = options.appCallbackUrl.trim();
  if (!authJsonPath) {
    throw new Error("authJsonPath is required");
  }
  if (!appCallbackUrl) {
    throw new Error("appCallbackUrl is required");
  }
  new URL(appCallbackUrl);

  const appId = options.appId?.trim() || DEFAULT_APP_ID;
  const accountBaseUrl =
    options.accountBaseUrl?.trim() || DEFAULT_ACCOUNT_BASE_URL;
  const authLoginUrl = options.authLoginUrl?.trim() || DEFAULT_AUTH_LOGIN_URL;
  const openUrl = options.openUrl ?? openUrlWithDefaultBrowser;
  const idleTimeoutMs = positiveMs(
    options.loginIdleTimeoutMs,
    DEFAULT_LOGIN_IDLE_TIMEOUT_MS
  );
  const maxTimeoutMs = Math.max(
    idleTimeoutMs,
    positiveMs(options.loginMaxTimeoutMs, DEFAULT_LOGIN_MAX_TIMEOUT_MS)
  );
  const accountHeaders = { ...options.accountHeaders };

  async function readSession(): Promise<TuttiAuthSession | null> {
    return await readAuthJson(authJsonPath);
  }

  async function clearSession(): Promise<void> {
    await rm(authJsonPath, { force: true });
  }

  async function getUserInfo(): Promise<TuttiUserInfo | null> {
    const session = await readSession();
    if (!session) {
      return null;
    }
    const user = await fetchUserInfo(
      accountBaseUrl,
      session.cookie,
      accountHeaders
    );
    if (!user) {
      return null;
    }
    await writeAuthJson(authJsonPath, sessionFromUser(session.sessionId, user));
    return user;
  }

  return {
    async login(): Promise<{ session: TuttiAuthSession; user: TuttiUserInfo }> {
      const port = await findAvailablePort();
      const localServerOrigin = `http://${AUTH_SERVER_HOST}:${port}`;
      const attemptId = randomUUID();
      const bridgeToken = randomUUID();
      const deviceId = options.deviceId?.trim() || randomUUID();
      const now = Date.now();
      const state = encodeBridgeState({
        v: 1,
        flow: "desktop_bridge",
        attemptId,
        localServerOrigin,
        bridgeToken,
        appId,
        appCallbackUrl,
        deviceId,
        deviceName: options.deviceName?.trim() || hostname() || "Desktop",
        clientVersion: options.clientVersion?.trim() || undefined,
        hostname: options.hostname?.trim() || hostname()
      });
      const pending: PendingLogin = {
        accountHeaders,
        accountBaseUrl,
        appId,
        appCallbackUrl,
        authJsonPath,
        attemptId,
        authOrigin: new URL(authLoginUrl).origin,
        bridgeToken,
        completed: false,
        deviceId,
        expiresAt: now + maxTimeoutMs,
        idleTimeoutMs,
        localServerOrigin,
        maxExpiresAt: now + maxTimeoutMs,
        state
      };
      const bridge = await createLoginBridgeServer(pending, port);
      const loginUrl = buildLoginUrl(authLoginUrl, state);
      const completion = waitForCompletion(pending, bridge.waitForCompletion);
      void completion.catch(() => undefined);

      try {
        await openUrl(loginUrl);
        const transferCode = await completion;
        if (pending.completedResult) {
          return pending.completedResult;
        }
        return await completePendingLogin(pending, transferCode);
      } finally {
        await closeServer(bridge.server);
      }
    },
    getUserInfo,
    logout: async (): Promise<void> => {
      const session = await readSession();
      if (session) {
        await logoutSession(
          accountBaseUrl,
          appId,
          session.cookie,
          accountHeaders
        );
      }
      await clearSession();
    },
    readSession,
    clearSession
  };
}

export async function readAuthJson(
  authJsonPath: string
): Promise<TuttiAuthSession | null> {
  try {
    const parsed = JSON.parse(await readFile(authJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    const sessionId =
      trimString(parsed.sessionId) || trimString(parsed.session_id);
    if (!sessionId) {
      return null;
    }
    return {
      sessionId,
      cookie: trimString(parsed.cookie) || buildSessionCookie(sessionId),
      userId: trimString(parsed.userId) || trimString(parsed.user_id),
      name: trimString(parsed.name),
      avatar: trimString(parsed.avatar),
      email: trimString(parsed.email),
      updatedAt:
        typeof parsed.updatedAt === "number" &&
        Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : Date.now()
    };
  } catch {
    return null;
  }
}

export async function writeAuthJson(
  authJsonPath: string,
  session: TuttiAuthSession
): Promise<void> {
  await mkdir(dirname(authJsonPath), { recursive: true });
  const payload = {
    session_id: session.sessionId,
    cookie: session.cookie,
    user_id: session.userId,
    name: session.name,
    avatar: session.avatar,
    email: session.email,
    updatedAt: session.updatedAt
  };
  const tempPath = `${authJsonPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  try {
    await writeFile(tempPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(tempPath, authJsonPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function encodeBridgeState(state: BridgeState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function decodeBridgeState(rawState: string): BridgeState | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(rawState, "base64url").toString("utf8")
    ) as Partial<BridgeState>;
    if (
      parsed.v !== 1 ||
      parsed.flow !== "desktop_bridge" ||
      !trimString(parsed.attemptId) ||
      !trimString(parsed.localServerOrigin) ||
      !trimString(parsed.bridgeToken)
    ) {
      return null;
    }
    return parsed as BridgeState;
  } catch {
    return null;
  }
}

function buildLoginUrl(authLoginUrl: string, state: string): string {
  const url = new URL(authLoginUrl);
  url.pathname = "/auth/login";
  url.search = "";
  url.hash = "";
  url.searchParams.set("state", state);
  return url.toString();
}

function stateMatches(input: PendingLogin, rawState: string): boolean {
  const state = decodeBridgeState(rawState);
  return (
    !input.completed &&
    Date.now() <= input.maxExpiresAt &&
    state?.attemptId === input.attemptId &&
    state.bridgeToken === input.bridgeToken &&
    state.localServerOrigin === input.localServerOrigin &&
    (state.appId ?? "") === input.appId
  );
}

async function createLoginBridgeServer(
  input: PendingLogin,
  port: number
): Promise<BridgeServer> {
  let resolveCompletion!: (code: string) => void;
  let rejectCompletion!: (error: unknown) => void;
  let completed = false;
  const waitForCompletion = new Promise<string>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const complete = (fn: () => void): void => {
    if (completed) {
      return;
    }
    completed = true;
    fn();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", input.localServerOrigin);

    if (req.method === "OPTIONS") {
      if (
        !isAllowedBridgeOrigin(req, input) ||
        !isAllowedLoopbackHost(req, port)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      sendCors(res, 204);
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/health") {
      const matched =
        !input.completed &&
        Date.now() <= input.expiresAt &&
        Date.now() <= input.maxExpiresAt &&
        url.searchParams.get("attempt_id") === input.attemptId &&
        url.searchParams.get("token") === input.bridgeToken;
      if (!matched) {
        sendJson(res, 401, {
          ok: false,
          error: {
            code: "INVALID_BRIDGE_ATTEMPT",
            message: "Desktop login attempt is unavailable."
          }
        });
        return;
      }
      input.expiresAt = Math.min(
        input.maxExpiresAt,
        Date.now() + input.idleTimeoutMs
      );
      sendJson(res, 200, {
        ok: true,
        data: {
          attemptId: input.attemptId,
          status: "ready",
          expiresAt: input.expiresAt
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      if (!isAllowedLoopbackHost(req, port)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const callbackError = trimString(url.searchParams.get("error"));
      const callbackState = trimString(url.searchParams.get("state"));
      const transferCode = trimString(url.searchParams.get("transfer_code"));
      if (!stateMatches(input, callbackState)) {
        const error = new Error("Invalid state");
        complete(() => rejectCompletion(error));
        sendRedirect(res, buildBridgeResultUrl(input, "error", "invalidState"));
        return;
      }
      if (callbackError) {
        const error = callbackErrorToError(callbackError);
        complete(() => rejectCompletion(error));
        sendRedirect(
          res,
          buildBridgeResultUrl(
            input,
            "error",
            callbackErrorToSafeResultCode(callbackError)
          )
        );
        return;
      }
      if (!transferCode) {
        const error = new Error("Missing transfer_code");
        complete(() => rejectCompletion(error));
        sendRedirect(
          res,
          buildBridgeResultUrl(input, "error", "missingTransferCode")
        );
        return;
      }
      try {
        input.completedResult = await completePendingLogin(input, transferCode);
        input.completed = true;
        complete(() => resolveCompletion(transferCode));
        sendRedirect(res, buildBridgeResultUrl(input, "success"));
      } catch (error) {
        complete(() => rejectCompletion(error));
        sendRedirect(res, buildBridgeResultUrl(input, "error", "redeemFailed"));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/oauth/complete") {
      if (
        !isAllowedBridgeOrigin(req, input) ||
        !isAllowedLoopbackHost(req, port)
      ) {
        sendJson(res, 403, {
          ok: false,
          error: {
            code: "FORBIDDEN_BRIDGE_ORIGIN",
            message: "Bridge origin is not allowed."
          }
        });
        return;
      }
      const payload = (await readJsonBody(req).catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const callbackError = trimString(payload.error);
      const callbackState = trimString(payload.state);
      const transferCode =
        trimString(payload.transfer_code) || trimString(payload.transferCode);
      if (!stateMatches(input, callbackState)) {
        const error = new Error("Invalid state");
        sendJson(res, 400, {
          ok: false,
          error: { code: "INVALID_STATE", message: error.message }
        });
        complete(() => rejectCompletion(error));
        return;
      }
      if (callbackError) {
        const error = callbackErrorToError(callbackError);
        sendJson(res, 400, {
          ok: false,
          error: {
            code: isTuttiAuthUserCancelledError(error)
              ? "USER_CANCELLED"
              : "PROVIDER_CALLBACK_ERROR",
            message: error.message
          }
        });
        complete(() => rejectCompletion(error));
        return;
      }
      if (!transferCode) {
        const error = new Error("Missing transfer_code");
        sendJson(res, 400, {
          ok: false,
          error: { code: "MISSING_TRANSFER_CODE", message: error.message }
        });
        complete(() => rejectCompletion(error));
        return;
      }
      input.completed = true;
      sendJson(res, 200, { ok: true, data: { status: "completed" } });
      complete(() => resolveCompletion(transferCode));
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: { code: "NOT_FOUND", message: "Not found" }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, AUTH_SERVER_HOST, () => resolve());
  });

  return { server, waitForCompletion };
}

async function completePendingLogin(
  input: PendingLogin,
  transferCode: string
): Promise<{ session: TuttiAuthSession; user: TuttiUserInfo }> {
  const sessionId = await redeemDesktopTransferCode(input, transferCode);
  const user = await fetchUserInfo(
    input.accountBaseUrl,
    buildSessionCookie(sessionId),
    input.accountHeaders
  );
  if (!user) {
    throw new Error("Failed to load user info after login");
  }
  const session = sessionFromUser(sessionId, user);
  await writeAuthJson(input.authJsonPath, session);
  return { session, user };
}

async function waitForCompletion(
  input: PendingLogin,
  completion: Promise<string>
): Promise<string> {
  while (true) {
    const remainingMs =
      Math.min(input.expiresAt, input.maxExpiresAt) - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Login timed out");
    }
    const result = await Promise.race([
      completion.then((transferCode) => ({ transferCode })),
      delay(Math.min(remainingMs, 500)).then(() => null)
    ]);
    if (result) {
      return result.transferCode;
    }
  }
}

async function fetchUserInfo(
  accountBaseUrl: string,
  cookie: string,
  accountHeaders: Readonly<Record<string, string>>
): Promise<TuttiUserInfo | null> {
  const response = await fetch(
    buildAccountUrl(accountBaseUrl, "/user/v1/user_info"),
    {
      method: "POST",
      headers: buildAccountHeaders(accountHeaders, cookie),
      body: JSON.stringify({})
    }
  );
  const payload = (await response.json().catch(() => null)) as AccountEnvelope<
    Record<string, unknown>
  > | null;
  if (response.status === 401 || payload?.code === 401) {
    return null;
  }
  if (!response.ok || payload?.code !== 0) {
    throw readEnvelopeError(response, payload);
  }
  return mapUserInfo(payload.data);
}

async function redeemDesktopTransferCode(
  input: PendingLogin,
  transferCode: string
): Promise<string> {
  const response = await fetch(
    buildAccountUrl(
      input.accountBaseUrl,
      "/auth/v1/redeem_desktop_transfer_code"
    ),
    {
      method: "POST",
      headers: buildAccountHeaders(input.accountHeaders),
      body: JSON.stringify({
        transfer_code: transferCode,
        attempt_id: input.attemptId,
        bridge_token: input.bridgeToken,
        app_id: input.appId,
        device_id: input.deviceId
      })
    }
  );
  const payload = (await response.json().catch(() => null)) as AccountEnvelope<{
    session_id?: string;
    sessionId?: string;
  }> | null;
  const sessionId =
    trimString(payload?.data?.sessionId) ||
    trimString(payload?.data?.session_id);
  if (!response.ok || payload?.code !== 0 || !sessionId) {
    throw readEnvelopeError(response, payload);
  }
  return sessionId;
}

async function logoutSession(
  accountBaseUrl: string,
  appId: string,
  cookie: string,
  accountHeaders: Readonly<Record<string, string>>
): Promise<void> {
  const response = await fetch(
    buildAccountUrl(accountBaseUrl, "/auth/v1/logout-web-session"),
    {
      method: "POST",
      headers: buildAccountHeaders(accountHeaders, cookie),
      body: JSON.stringify({ app_id: appId })
    }
  );
  const payload = (await response.json().catch(() => null)) as AccountEnvelope<
    Record<string, never>
  > | null;
  if (!response.ok || (payload?.code ?? 0) !== 0) {
    throw readEnvelopeError(response, payload);
  }
}

function buildAccountHeaders(
  accountHeaders: Readonly<Record<string, string>>,
  cookie?: string
): Headers {
  const headers = new Headers(accountHeaders);
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  if (cookie) {
    headers.set("Cookie", cookie);
  } else {
    headers.delete("Cookie");
  }
  return headers;
}

async function findAvailablePort(): Promise<number> {
  for (
    let port = AUTH_SERVER_BASE_PORT;
    port <= AUTH_SERVER_MAX_PORT;
    port += 1
  ) {
    const available = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, AUTH_SERVER_HOST, () => {
        probe.close(() => resolve(true));
      });
    });
    if (available) {
      return port;
    }
  }
  throw new Error("unable to allocate localhost auth port");
}

function sessionFromUser(
  sessionId: string,
  user: TuttiUserInfo
): TuttiAuthSession {
  return {
    sessionId,
    cookie: buildSessionCookie(sessionId),
    userId: user.userId,
    name: user.name ?? "",
    avatar: user.avatar ?? "",
    email: user.email ?? "",
    updatedAt: Date.now()
  };
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? JSON.parse(raw) : {};
}

function sendCors(res: ServerResponse, status: number): void {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    Connection: "close"
  });
  res.end();
}

function isAllowedBridgeOrigin(
  req: IncomingMessage,
  input: PendingLogin
): boolean {
  const origin = trimString(req.headers.origin);
  return !origin || origin === input.authOrigin;
}

function isAllowedLoopbackHost(req: IncomingMessage, port: number): boolean {
  const host = trimString(req.headers.host).toLowerCase();
  return host === `${AUTH_SERVER_HOST}:${port}` || host === `localhost:${port}`;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Content-Type": "application/json; charset=utf-8",
    Connection: "close"
  });
  res.end(JSON.stringify(payload));
}

function sendRedirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, Connection: "close" });
  res.end();
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections();
      resolve();
    }, BRIDGE_SERVER_FORCE_CLOSE_TIMEOUT_MS);
    forceCloseTimer.unref();

    server.close(() => {
      clearTimeout(forceCloseTimer);
      resolve();
    });
    server.closeIdleConnections();
  });
}

function openUrlWithDefaultBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url] }
        : { file: "xdg-open", args: [url] };
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export {
  isTuttiAuthUserCancelledError,
  TuttiAuthError
} from "./node-login-result";
export type { TuttiAuthErrorCode } from "./node-login-result";
export type { TuttiAuthSession, TuttiUserInfo } from "./shared";
