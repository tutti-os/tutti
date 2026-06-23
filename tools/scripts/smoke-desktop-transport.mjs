import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const smokeTimeoutMs = 15_000;
const requestTimeoutMs = 5_000;
const healthPollIntervalMs = 250;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");

const stateDir = await mkdtemp(join(tmpdir(), "tutti-transport-smoke-"));
const accessToken = randomBytes(32).toString("base64url");
const daemonPath = join(
  stateDir,
  process.platform === "win32" ? "tuttid.exe" : "tuttid"
);
const listenerInfoPath = join(stateDir, "run", "tuttid.listener.json");

await buildDaemon(daemonPath);

const child = spawn(daemonPath, [], {
  cwd: workspaceRoot,
  env: {
    ...process.env,
    TUTTI_ENV: "development",
    TUTTI_STATE_DIR: stateDir,
    TUTTID_ACCESS_TOKEN: accessToken,
    TUTTID_ADDR: "127.0.0.1:0",
    TUTTID_LISTENER_INFO_PATH: listenerInfoPath,
    TUTTID_LOG_OUTPUT: "tee"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdoutLog = "";
let stderrLog = "";

child.stdout?.on("data", (chunk) => {
  const text = chunk.toString();
  stdoutLog += text;
  process.stdout.write(`[tuttid] ${text}`);
});

child.stderr?.on("data", (chunk) => {
  const text = chunk.toString();
  stderrLog += text;
  process.stderr.write(`[tuttid] ${text}`);
});

try {
  await waitForHealth(listenerInfoPath, accessToken, () =>
    isAlive(child.exitCode, child.signalCode)
  );
  console.log("desktop transport smoke test passed via managed loopback");
  console.log(`state dir: ${stateDir}`);
  console.log(`listener info path: ${listenerInfoPath}`);
} catch (error) {
  console.error("desktop transport smoke test failed via managed loopback");
  console.error(`state dir: ${stateDir}`);
  console.error(`listener info path: ${listenerInfoPath}`);
  if (stdoutLog.trim()) {
    console.error("stdout:");
    process.stderr.write(stdoutLog);
  }
  if (stderrLog.trim()) {
    console.error("stderr:");
    process.stderr.write(stderrLog);
  }
  throw error;
} finally {
  await stopChild(child);
  await rm(stateDir, { recursive: true, force: true });
}

function isAlive(exitCode, signalCode) {
  return exitCode === null && signalCode === null;
}

async function buildDaemon(outputPath) {
  await runCommand("pnpm", ["generate:builtin-apps"], {
    cwd: workspaceRoot,
    errorPrefix: "failed to generate builtin apps for smoke test"
  });
  await runCommand("go", ["build", "-o", outputPath, "./services/tuttid"], {
    cwd: workspaceRoot,
    errorPrefix: "failed to build tuttid for smoke test"
  });
}

function runCommand(command, args, { cwd, errorPrefix }) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${errorPrefix}:\n${stdout}${stderr}`));
        return;
      }

      resolve(undefined);
    });
  });
}

async function waitForHealth(listenerInfoPathToCheck, token, isProcessAlive) {
  const deadline = Date.now() + smokeTimeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (!isProcessAlive()) {
      throw new Error(
        `tuttid exited before health check succeeded: ${String(lastError ?? "unknown error")}`
      );
    }

    try {
      const baseUrl = await readListenerInfoBaseUrl(listenerInfoPathToCheck);
      const response = await requestHealth(baseUrl, token);
      if (response?.status === "ok") {
        return;
      }
      lastError = new Error(
        `unexpected health response: ${JSON.stringify(response)}`
      );
    } catch (error) {
      lastError = error;
    }

    await sleep(healthPollIntervalMs);
  }

  throw new Error(
    `timed out waiting for tuttid health: ${String(lastError ?? "unknown error")}`
  );
}

async function readListenerInfoBaseUrl(listenerInfoPathToRead) {
  const body = await readFile(listenerInfoPathToRead, "utf8");
  const listenerInfo = JSON.parse(body);
  if (!listenerInfo.addr || typeof listenerInfo.addr !== "string") {
    throw new Error(`invalid listener info: ${body}`);
  }

  return `http://${listenerInfo.addr}`;
}

async function requestHealth(baseUrl, token) {
  const response = await fetch(new URL("/v1/health", baseUrl), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(
      `health request failed with status ${response.status} ${response.statusText}`.trim()
    );
  }

  return response.json();
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
    return;
  }

  childProcess.kill("SIGINT");

  await Promise.race([
    onceExit(childProcess),
    sleep(5_000).then(() => {
      if (childProcess.exitCode === null && childProcess.signalCode === null) {
        childProcess.kill("SIGKILL");
      }
    })
  ]);
}

function onceExit(childProcess) {
  return new Promise((resolve) => {
    childProcess.once("exit", () => resolve(undefined));
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
