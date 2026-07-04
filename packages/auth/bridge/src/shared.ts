export const DEFAULT_APP_ID = "nextop";
export const DEFAULT_ACCOUNT_BASE_URL = "https://tutti.sh/api/account";
export const DEFAULT_AUTH_LOGIN_URL = "https://tutti.sh/auth/login";
export const AUTH_SERVER_HOST = "127.0.0.1";
export const AUTH_SERVER_BASE_PORT = 38473;
export const AUTH_SERVER_MAX_PORT = 38492;
export const DEFAULT_LOGIN_IDLE_TIMEOUT_MS = 90_000;
export const DEFAULT_LOGIN_MAX_TIMEOUT_MS = 5 * 60_000;

export interface TuttiUserInfo {
  userId: string;
  name?: string;
  email?: string;
  avatar?: string;
}

export interface TuttiAuthSession {
  sessionId: string;
  cookie: string;
  userId: string;
  name: string;
  avatar: string;
  email: string;
  updatedAt: number;
}

export interface AccountEnvelope<T> {
  code?: number;
  errmsg?: string;
  message?: string;
  data?: T;
}

export function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function buildSessionCookie(sessionId: string): string {
  return `session_id=${sessionId.trim()}`;
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function buildAccountUrl(accountBaseUrl: string, path: string): string {
  return `${normalizeBaseUrl(accountBaseUrl)}/${path.replace(/^\/+/u, "")}`;
}

export function readEnvelopeError<T>(
  response: Response,
  payload: AccountEnvelope<T> | null
): Error {
  return new Error(
    payload?.errmsg ??
      payload?.message ??
      `Request failed with status ${response.status}`
  );
}

export function mapUserInfo(
  data: Record<string, unknown> | undefined
): TuttiUserInfo | null {
  if (!data) {
    return null;
  }
  const userId = trimString(data.userId) || trimString(data.user_id);
  if (!userId) {
    return null;
  }
  return {
    userId,
    name: trimString(data.name) || undefined,
    email:
      trimString(data.email) ||
      trimString(data.userEmail) ||
      trimString(data.emailAddress) ||
      undefined,
    avatar:
      trimString(data.avatar) ||
      trimString(data.picture) ||
      trimString(data.avatarUrl) ||
      trimString(data.headImg) ||
      undefined
  };
}
