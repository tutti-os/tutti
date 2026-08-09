import type {
  BrowserNodeAutomationAuthorizationInput,
  BrowserNodeAutomationAuthorizationResult
} from "./automationTypes.ts";

export function createBrowserNodeAutomationNetworkAuthorizer(): (
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

function blocked(
  code: string,
  message: string
): BrowserNodeAutomationAuthorizationResult {
  return { allowed: false, code, message };
}
