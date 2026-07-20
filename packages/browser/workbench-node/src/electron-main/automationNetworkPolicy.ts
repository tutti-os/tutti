import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  BrowserNodeAutomationAuthorizationInput,
  BrowserNodeAutomationAuthorizationResult
} from "./automationTypes.ts";

export interface BrowserNodeAutomationNetworkPolicyOptions {
  isLoopbackUrlRouted?: (url: string) => boolean | Promise<boolean>;
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

export function createBrowserNodeAutomationNetworkAuthorizer(
  options: BrowserNodeAutomationNetworkPolicyOptions = {}
): (
  input: BrowserNodeAutomationAuthorizationInput
) => Promise<BrowserNodeAutomationAuthorizationResult> {
  return async (input) => {
    const candidate = resolveAuthorizationUrl(input);
    if (candidate === "about:blank") {
      return { allowed: true };
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return blocked("invalid_url", "The browser URL is invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return blocked(
        "unsupported_protocol",
        "Browser automation only supports HTTP and HTTPS pages"
      );
    }

    const hostname = normalizeHostname(url.hostname);
    if (isLoopbackHostname(hostname)) {
      const routed = await options.isLoopbackUrlRouted?.(url.toString());
      return routed === true
        ? { allowed: true }
        : blocked("private_network_blocked", "Loopback pages are not allowed");
    }
    if (hostname.endsWith(".local")) {
      return blocked(
        "private_network_blocked",
        "Local-network pages are not available to browser automation"
      );
    }

    let addresses: readonly string[];
    try {
      const resolveHost =
        input.resolveHost ?? options.resolveHost ?? resolveHostnameAddresses;
      addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
    } catch {
      return blocked(
        "host_resolution_failed",
        "The browser host could not be resolved safely"
      );
    }
    if (
      addresses.length === 0 ||
      addresses.some((address) => !isAllowedAddress(address))
    ) {
      return blocked(
        "private_network_blocked",
        "Private, link-local, and metadata-network pages are not available to browser automation"
      );
    }
    return { allowed: true };
  };
}

function resolveAuthorizationUrl(
  input: BrowserNodeAutomationAuthorizationInput
): string {
  if (input.tool === "navigate_page" || input.tool === "new_page") {
    const candidate = input.args.url;
    return typeof candidate === "string" ? candidate.trim() : "";
  }
  return input.target?.url.trim() || "about:blank";
}

async function resolveHostnameAddresses(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(
    ({ address }) => address
  );
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/gu, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  if (!hostname.includes(".")) return false;
  const octets = hostname.split(".").map(Number);
  return octets.length === 4 && octets[0] === 127;
}

function isAllowedAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized.includes(":")) {
    return isAllowedIPv6(normalized);
  }
  return isAllowedIPv4(normalized);
}

function isAllowedIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) {
    return false;
  }
  const a = octets[0]!;
  const b = octets[1]!;
  return !(
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isAllowedIPv6(address: string): boolean {
  if (address === "::" || address === "::1" || address.startsWith("ff")) {
    return false;
  }
  if (address.startsWith("::ffff:")) {
    return isAllowedIPv4(address.slice("::ffff:".length));
  }
  const first = Number.parseInt(address.split(":", 1)[0] || "0", 16);
  return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
}

function blocked(
  code: string,
  message: string
): BrowserNodeAutomationAuthorizationResult {
  return { allowed: false, code, message };
}
