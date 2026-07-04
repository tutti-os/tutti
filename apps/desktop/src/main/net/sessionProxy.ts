import { getDesktopLogger } from "../logging.ts";

interface ShellProxyRules {
  proxyRules: string;
  proxyBypassRules: string;
}

// Chromium already follows the OS proxy (and PAC) by itself. This module
// covers the remaining case: users whose proxy exists only as shell env vars
// (`export https_proxy=...` in ~/.zshrc). Spawned agents receive those vars
// through the user-shell env forwarding; applying them to the Chromium session
// keeps the desktop's own outbound requests (net/outboundFetch) on the same
// route.
export function resolveShellProxyRules(
  env: Record<string, string>
): ShellProxyRules | null {
  const proxyRules = firstNonEmpty(
    env,
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy"
  );
  if (!proxyRules) {
    return null;
  }
  const bypass = firstNonEmpty(env, "NO_PROXY", "no_proxy");
  return {
    proxyRules,
    proxyBypassRules: bypass ?? "<local>"
  };
}

export async function applyUserShellProxyToSession(
  userShellEnv: Record<string, string>
): Promise<void> {
  const rules = resolveShellProxyRules(userShellEnv);
  if (!rules) {
    return;
  }
  const logger = getDesktopLogger();
  try {
    const { app, session } = await import("electron");
    await app.whenReady();
    // Conservative fallback: only apply the shell proxy when Chromium would
    // otherwise connect directly. When an OS proxy or PAC is configured,
    // Chromium's own resolution stays authoritative for desktop requests —
    // overriding PAC with a single static rule would regress those setups.
    // (Agent processes resolve env-first instead; when both sources are set
    // they nearly always point at the same proxy.)
    const current = await session.defaultSession.resolveProxy(
      "https://api.anthropic.com/"
    );
    if (current.trim() !== "DIRECT") {
      return;
    }
    await session.defaultSession.setProxy(rules);
    logger.info("applied user shell proxy to Chromium session", {
      proxyRules: rules.proxyRules,
      proxyBypassRules: rules.proxyBypassRules
    });
  } catch (error) {
    logger.warn("failed to apply user shell proxy to Chromium session", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function firstNonEmpty(
  env: Record<string, string>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}
