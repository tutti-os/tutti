import { getDesktopLogger } from "../logging.ts";
import {
  defaultDesktopProxySettings,
  normalizeDesktopProxySettings,
  type DesktopProxySettings
} from "../../shared/preferences/index.ts";

interface ShellProxyRules {
  proxyRules: string;
  proxyBypassRules: string;
}

interface ProxySession {
  resolveProxy(url: string): Promise<string>;
  setProxy(config: Electron.ProxyConfig): Promise<void>;
}

let shellProxyRules: ShellProxyRules | null = null;

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
  shellProxyRules = resolveShellProxyRules(userShellEnv);
  if (!shellProxyRules) {
    return;
  }
  const logger = getDesktopLogger();
  try {
    const { app, session } = await import("electron");
    await app.whenReady();
    await applyAutomaticProxyToSession(session.defaultSession);
    logger.info("applied user shell proxy to Chromium session", {
      proxyRules: shellProxyRules.proxyRules,
      proxyBypassRules: shellProxyRules.proxyBypassRules
    });
  } catch (error) {
    logger.warn("failed to apply user shell proxy to Chromium session", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export interface DesktopProxySessionController {
  configure(settings: DesktopProxySettings): Promise<void>;
  dispose(): void;
}

export async function createDesktopProxySessionController(): Promise<DesktopProxySessionController> {
  const { app, session } = await import("electron");
  await app.whenReady();
  const sessions = new Set<ProxySession>([session.defaultSession]);
  let settings = { ...defaultDesktopProxySettings };

  const apply = async (target: ProxySession): Promise<void> => {
    if (settings.mode === "manual") {
      await target.setProxy(resolveManualProxyRules(settings.port));
      return;
    }
    await applyAutomaticProxyToSession(target);
  };
  const onSessionCreated = (createdSession: Electron.Session): void => {
    sessions.add(createdSession);
    void apply(createdSession).catch((error: unknown) => {
      getDesktopLogger().warn("failed to apply proxy to Chromium session", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };
  app.on("session-created", onSessionCreated);

  return {
    async configure(nextSettings) {
      settings = normalizeDesktopProxySettings(nextSettings);
      const results = await Promise.allSettled([...sessions].map(apply));
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      if (rejected) {
        throw rejected.reason;
      }
    },
    dispose() {
      app.off("session-created", onSessionCreated);
      sessions.clear();
    }
  };
}

export function resolveManualProxyRules(port: number): Electron.ProxyConfig {
  const normalized = normalizeDesktopProxySettings({ mode: "manual", port });
  return {
    mode: "fixed_servers",
    proxyRules: `http://127.0.0.1:${normalized.port}`,
    proxyBypassRules: "<local>"
  };
}

async function applyAutomaticProxyToSession(
  target: ProxySession
): Promise<void> {
  await target.setProxy({ mode: "system" });
  if (!shellProxyRules) {
    return;
  }
  // Conservative fallback: only apply the shell proxy when Chromium would
  // otherwise connect directly. When an OS proxy or PAC is configured,
  // Chromium's own resolution stays authoritative.
  const current = await target.resolveProxy("https://api.anthropic.com/");
  if (current.trim() === "DIRECT") {
    await target.setProxy(shellProxyRules);
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
