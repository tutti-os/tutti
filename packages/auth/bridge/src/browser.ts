import {
  type AccountEnvelope,
  buildAccountUrl,
  DEFAULT_ACCOUNT_BASE_URL,
  DEFAULT_APP_ID,
  DEFAULT_AUTH_LOGIN_URL,
  mapUserInfo,
  readEnvelopeError,
  type TuttiUserInfo
} from "./shared";

export interface TuttiBrowserAuthClientOptions {
  openUrl?: (url: string) => void;
  appId?: string;
  accountBaseUrl?: string;
  authLoginUrl?: string;
}

export interface TuttiBrowserLoginOptions {
  redirectUri?: string;
  locale?: string;
}

export interface TuttiBrowserAuthClient {
  login: (options?: TuttiBrowserLoginOptions) => void;
  getUserInfo: () => Promise<TuttiUserInfo | null>;
  logout: () => Promise<void>;
}

function defaultOpenUrl(url: string): void {
  window.location.assign(url);
}

function resolveCurrentRedirectUri(): string {
  return (
    `${window.location.pathname}${window.location.search}${window.location.hash}` ||
    "/"
  );
}

async function readJsonEnvelope<T>(
  response: Response
): Promise<AccountEnvelope<T> | null> {
  return (await response.json().catch(() => null)) as AccountEnvelope<T> | null;
}

export function createTuttiBrowserAuthClient(
  options: TuttiBrowserAuthClientOptions = {}
): TuttiBrowserAuthClient {
  const appId = options.appId?.trim() || DEFAULT_APP_ID;
  const accountBaseUrl =
    options.accountBaseUrl?.trim() || DEFAULT_ACCOUNT_BASE_URL;
  const authLoginUrl = options.authLoginUrl?.trim() || DEFAULT_AUTH_LOGIN_URL;
  const openUrl = options.openUrl ?? defaultOpenUrl;

  return {
    login(loginOptions: TuttiBrowserLoginOptions = {}): void {
      const url = new URL(authLoginUrl);
      url.searchParams.set(
        "redirect_uri",
        loginOptions.redirectUri ?? resolveCurrentRedirectUri()
      );
      if (loginOptions.locale) {
        url.searchParams.set("locale", loginOptions.locale);
      }
      openUrl(url.toString());
    },

    async getUserInfo(): Promise<TuttiUserInfo | null> {
      const response = await fetch(
        buildAccountUrl(accountBaseUrl, "/user/v1/user_info"),
        {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({})
        }
      );
      const payload = await readJsonEnvelope<Record<string, unknown>>(response);
      if (response.status === 401 || payload?.code === 401) {
        return null;
      }
      if (!response.ok || payload?.code !== 0) {
        throw readEnvelopeError(response, payload);
      }
      return mapUserInfo(payload.data);
    },

    async logout(): Promise<void> {
      const response = await fetch(
        buildAccountUrl(accountBaseUrl, "/auth/v1/logout-web-session"),
        {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ appId })
        }
      );
      const payload = await readJsonEnvelope<Record<string, never>>(response);
      if (!response.ok || (payload?.code ?? 0) !== 0) {
        throw readEnvelopeError(response, payload);
      }
    }
  };
}

export type { TuttiUserInfo } from "./shared";
