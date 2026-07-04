import { spawn } from "node:child_process";

export const userShellEnvTimeoutMs = 10_000;

const marker = "__TUTTI_USER_SHELL_ENV_START__";
const envCommand = `printf '%s\\0' ${marker}; env -0`;
const maxShellEnvOutputBytes = 1024 * 1024;
const allowedEnvKeys = new Set([
  "ALL_PROXY",
  "ASDF_DATA_DIR",
  "ASDF_DIR",
  "FNM_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "NO_PROXY",
  "N_PREFIX",
  "PATH",
  "PNPM_HOME",
  "VOLTA_HOME",
  // Proxy vars are conventionally lowercase in shell configs; Go's
  // httpproxy.FromEnvironment and most CLIs read both spellings, so forward
  // them verbatim without case normalization.
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy"
]);
const allowedEnvPrefixes = ["MISE_"];

export function resolveUserShellEnvInvocation(
  platform: NodeJS.Platform = process.platform,
  shell: string = process.env.SHELL || ""
): { args: string[]; shell: string } | null {
  if (platform === "win32") {
    return null;
  }

  const resolvedShell = shell.trim() || "/bin/zsh";
  const shellName = resolvedShell.split("/").pop() ?? "";
  if (shellName === "zsh" || shellName === "bash") {
    return { args: ["-lic", envCommand], shell: resolvedShell };
  }
  if (shellName === "fish") {
    return { args: ["-l", "-i", "-c", envCommand], shell: resolvedShell };
  }
  return { args: ["-lc", envCommand], shell: resolvedShell };
}

export function parseAllowedUserShellEnv(
  output: Buffer | string
): Record<string, string> {
  const raw = Buffer.isBuffer(output) ? output.toString("utf8") : output;
  const markerIndex = raw.indexOf(`${marker}\0`);
  if (markerIndex < 0) {
    return {};
  }

  const result: Record<string, string> = {};
  const envOutput = raw.slice(markerIndex + marker.length + 1);
  for (const item of envOutput.split("\0")) {
    const separator = item.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = item.slice(0, separator);
    if (!isAllowedUserShellEnvKey(key)) {
      continue;
    }
    result[key] = item.slice(separator + 1);
  }
  return result;
}

export function resolveUserShellEnv(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    shell?: string;
    timeoutMs?: number;
  } = {}
): Promise<Record<string, string>> {
  const invocation = resolveUserShellEnvInvocation(
    options.platform,
    options.shell ?? options.env?.SHELL
  );
  if (!invocation) {
    return Promise.resolve({});
  }

  const timeoutMs = options.timeoutMs ?? userShellEnvTimeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.shell, invocation.args, {
      env: options.env ?? process.env,
      windowsHide: true
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (totalBytes >= maxShellEnvOutputBytes) {
        return;
      }
      totalBytes += chunk.length;
      chunks.push(chunk);
    });
    child.stderr?.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`user shell env timed out after ${timeoutMs}ms`));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`user shell env exited with code ${exitCode ?? 1}`));
        return;
      }
      resolve(parseAllowedUserShellEnv(Buffer.concat(chunks)));
    });
  });
}

function isAllowedUserShellEnvKey(key: string): boolean {
  return (
    allowedEnvKeys.has(key) ||
    allowedEnvPrefixes.some((prefix) => key.startsWith(prefix))
  );
}
