#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultBundleDir = join(__dirname, "..", "build", "claude-sdk-sidecar");
const DEFAULT_TIMEOUT_MS = 15_000;

export async function smokeClaudeSDKSidecar({
  bundleDir = defaultBundleDir,
  nodeExecutable = process.execPath,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const entry = join(bundleDir, "src", "main.ts");
  const child = spawn(nodeExecutable, ["--experimental-strip-types", entry], {
    cwd: bundleDir,
    env: {
      ...process.env,
      TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER: "1"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  void exitPromise.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_000);
  });

  const send = (request) => {
    child.stdin.write(`${JSON.stringify({ version: 1, ...request })}\n`);
  };
  const waitForEvent = async (predicate, label) => {
    while (true) {
      const next = await withTimeout(
        iterator.next(),
        timeoutMs,
        `timed out waiting for ${label}`
      );
      if (next.done) {
        throw new Error(`sidecar exited before ${label}`);
      }
      const event = JSON.parse(next.value);
      if (event.type === "error") {
        throw new Error(`sidecar protocol error: ${JSON.stringify(event)}`);
      }
      if (predicate(event)) {
        return event;
      }
    }
  };

  try {
    send({
      id: "smoke-start",
      type: "start",
      payload: {
        agentSessionId: "smoke-agent-session",
        providerSessionId: "smoke-provider-session",
        cwd: bundleDir,
        env: {},
        settings: {}
      }
    });
    await waitForEvent(
      (event) => event.type === "session_started",
      "session_started"
    );

    send({
      id: "smoke-exec",
      type: "exec",
      payload: {
        agentSessionId: "smoke-agent-session",
        turnId: "smoke-turn",
        prompt: "sidecar startup smoke"
      }
    });
    await waitForEvent(
      (event) =>
        event.type === "turn_completed" &&
        event.payload?.turnId === "smoke-turn",
      "turn_completed"
    );

    send({
      id: "smoke-close",
      type: "close",
      payload: { agentSessionId: "smoke-agent-session" }
    });
    await waitForEvent(
      (event) => event.type === "ok" && event.id === "smoke-close",
      "close acknowledgement"
    );
    child.stdin.end();
    const exitCode = await withTimeout(
      exitPromise,
      timeoutMs,
      "timed out waiting for sidecar exit"
    );
    if (exitCode !== 0) {
      throw new Error(`sidecar exited with code ${String(exitCode)}`);
    }
  } catch (error) {
    child.kill();
    const detail = stderr.trim() ? `\nstderr:\n${stderr.trim()}` : "";
    throw new Error(
      `${error instanceof Error ? error.message : error}${detail}`
    );
  } finally {
    lines.close();
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const bundleDir = process.argv[2]
    ? resolve(process.argv[2])
    : defaultBundleDir;
  await smokeClaudeSDKSidecar({ bundleDir });
  process.stderr.write(`[smoke-claude-sdk-sidecar] OK: ${bundleDir}\n`);
}
