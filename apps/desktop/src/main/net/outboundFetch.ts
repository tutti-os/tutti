import { getDesktopLogger } from "../logging.ts";

type OutboundFetcher = (input: string, init?: RequestInit) => Promise<Response>;

let fetcherOverride: OutboundFetcher | null = null;
const proxyLoggedHosts = new Set<string>();

// Restores default behavior when passed null. Also resets the per-host proxy
// log dedupe so tests stay independent.
export function setOutboundFetcherForTesting(
  fetcher: OutboundFetcher | null
): void {
  fetcherOverride = fetcher;
  proxyLoggedHosts.clear();
}

// outboundFetch is the single funnel for non-local HTTP from the desktop main
// process. It rides Chromium's network stack (net.fetch), which resolves the
// OS proxy and PAC the same way the browser does. Node's global fetch (undici)
// resolves neither, so it silently bypasses the user's proxy — oxlint
// (no-restricted-globals) rejects direct fetch use under src/main for that
// reason. Requests to the local daemon or loopback origins may keep using
// global fetch with an inline oxlint disable.
export async function outboundFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  if (fetcherOverride) {
    return fetcherOverride(String(input), init);
  }
  const { app, net, session } = await import("electron");
  await app.whenReady();
  const url = new URL(String(input));
  if (!proxyLoggedHosts.has(url.host)) {
    proxyLoggedHosts.add(url.host);
    try {
      const proxy = await session.defaultSession.resolveProxy(url.href);
      getDesktopLogger().info("outbound fetch proxy resolved", {
        host: url.host,
        proxy
      });
    } catch {
      // Proxy resolution is observability only; never block the request.
    }
  }
  return net.fetch(url.href, init);
}
