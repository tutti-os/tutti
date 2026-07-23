# @tutti-os/auth-bridge

High-level Tutti auth helpers for browser apps and Node/Electron clients.

## Shared contract

Clients that implement their own platform-specific account UI can reuse the
canonical account defaults without importing Browser or Node runtime behavior:

```ts
import {
  DEFAULT_ACCOUNT_BASE_URL,
  DEFAULT_APP_ID
} from "@tutti-os/auth-bridge/shared";
```

Keep compatibility identifiers in this shared contract rather than copying
their literal values into product clients.

## Browser

```ts
import { createTuttiBrowserAuthClient } from "@tutti-os/auth-bridge/browser";

const auth = createTuttiBrowserAuthClient();

auth.login();
const user = await auth.getUserInfo();
await auth.logout();
```

## Node

```ts
import { createTuttiNodeAuthClient } from "@tutti-os/auth-bridge/node";

const auth = createTuttiNodeAuthClient({
  authJsonPath,
  appCallbackUrl,
  accountHeaders: { "x-environment-lane": "example" }
});

const { session, user } = await auth.login();
```

`accountHeaders` adds host-owned headers to Account API requests. The bridge
always owns and overwrites its JSON content negotiation and Desktop session
cookie headers.

## Local Desktop Callback

The Node bridge starts a loopback HTTP server for desktop sign-in. New desktop OAuth completions use:

- `GET /oauth/callback?state=<base64url>&transfer_code=<code>`
- `GET /oauth/callback?state=<base64url>&error=<providerError>`

The callback validates the signed login state, redeems the desktop transfer code through the account service, writes `auth.json`, fetches user info, and redirects the browser back to the web result page:

```text
/auth/login/callback?desktopBridgeStatus=success&openAppUrl=<safe-deeplink>
/auth/login/callback?desktopBridgeStatus=error&desktopBridgeError=<safeCode>&openAppUrl=<safe-deeplink>
```

`openAppUrl` is only used to focus or reopen Tutti. It is sanitized to the allowed app schemes and must not carry `transfer_code`, sessions, or tokens.

`/oauth/health` and `POST /oauth/complete` remain available for compatibility with older web clients, but the current web flow redirects the browser to `/oauth/callback` instead of fetching the local bridge.
