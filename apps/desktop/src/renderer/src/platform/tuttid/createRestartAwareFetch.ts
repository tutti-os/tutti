import type { DesktopRuntimeApi } from "@preload/types";

type BackendConfigRuntimeApi = Pick<DesktopRuntimeApi, "getBackendConfig">;

export function createRestartAwareFetch(
  runtimeApi: BackendConfigRuntimeApi,
  nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis)
): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const config = await runtimeApi.getBackendConfig();
    const requestUrl = new URL(request.url);
    const backendUrl = new URL(config.baseUrl);
    const rewrittenUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`,
      backendUrl.origin
    );
    const headers = new Headers(request.headers);
    const body =
      request.body === null ? undefined : await request.clone().arrayBuffer();

    headers.set("Authorization", `Bearer ${config.accessToken}`);

    // Passing a Request as RequestInit preserves its body as a ReadableStream.
    // Chromium only sends streaming uploads over HTTP/2 or QUIC, while the
    // managed loopback daemon intentionally serves HTTP/1.1. Materialize the
    // already-serialized client body before rebuilding the request so POST and
    // PUT calls remain ordinary HTTP/1.1 uploads after the origin changes.
    const rewrittenRequest = new Request(rewrittenUrl, {
      body,
      cache: request.cache,
      credentials: request.credentials,
      headers,
      integrity: request.integrity,
      keepalive: request.keepalive,
      method: request.method,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal
    });

    return nativeFetch(rewrittenRequest);
  };
}
