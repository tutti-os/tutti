#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const scriptPath = fileURLToPath(import.meta.url);
const childMode = process.argv.includes("--child");

if (childMode) {
  await runChild();
} else {
  await runParent();
}

async function runParent() {
  const iterations = positiveInteger(argumentValue("--iterations"), 5);
  const timeoutMs = positiveInteger(argumentValue("--timeout-ms"), 60_000);
  const cwd = argumentValue("--cwd") || process.cwd();
  const claudeBin = argumentValue("--claude-bin");
  const results = [];

  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    const result = await runOneChild({ cwd, timeoutMs, claudeBin });
    results.push({
      iteration: index + 1,
      processTotalMs: rounded(performance.now() - startedAt),
      ...result
    });
    process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
  }

  const successful = results.filter((result) => result.ok);
  process.stdout.write(
    `${JSON.stringify({
      summary: {
        iterations,
        successes: successful.length,
        sdkInitializationMs: summarize(
          successful.map((result) => result.sdkInitializationMs)
        ),
        sdkReinitializeMs: summarize(
          successful.map((result) => result.sdkReinitializeMs)
        ),
        processTotalMs: summarize(
          successful.map((result) => result.processTotalMs)
        )
      }
    })}\n`
  );
}

async function runChild() {
  const cwd = process.env.BENCH_CWD || process.cwd();
  const timeoutMs = positiveInteger(process.env.BENCH_TIMEOUT_MS, 60_000);
  const claudeBin = process.env.BENCH_CLAUDE_BIN || "";
  const startedAt = performance.now();
  let query;
  let prompt;

  try {
    const importStartedAt = performance.now();
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const sdkImportMs = rounded(performance.now() - importStartedAt);

    prompt = blockingPrompt();
    const constructStartedAt = performance.now();
    query = sdk.query({
      prompt,
      options: {
        cwd,
        env: {
          ...process.env,
          CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1"
        },
        sessionId: randomUUID(),
        ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
        includePartialMessages: true,
        permissionMode: "default",
        allowDangerouslySkipPermissions: false,
        canUseTool: async () => ({
          behavior: "deny",
          message: "model discovery benchmark does not allow tools"
        })
      }
    });
    const queryConstructMs = rounded(performance.now() - constructStartedAt);

    const initializationStartedAt = performance.now();
    const initialization = await withTimeout(
      query.initializationResult(),
      timeoutMs,
      "SDK initialization"
    );
    const sdkInitializationMs = rounded(
      performance.now() - initializationStartedAt
    );

    const reinitializeStartedAt = performance.now();
    const reinitialized = await withTimeout(
      query.reinitialize(),
      timeoutMs,
      "SDK reinitialize"
    );
    const sdkReinitializeMs = rounded(
      performance.now() - reinitializeStartedAt
    );

    const closeStartedAt = performance.now();
    query.close();
    prompt.close();
    const closeMs = rounded(performance.now() - closeStartedAt);

    process.stdout.write(
      JSON.stringify({
        ok: true,
        sdkImportMs,
        queryConstructMs,
        sdkInitializationMs,
        sdkReinitializeMs,
        closeMs,
        modelCount: modelCount(initialization),
        reinitializedModelCount: modelCount(reinitialized),
        cliResolution: claudeBin ? "explicit" : "sdk-native",
        childTotalMs: rounded(performance.now() - startedAt)
      })
    );
  } catch (error) {
    query?.close();
    prompt?.close();
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        childTotalMs: rounded(performance.now() - startedAt)
      })
    );
    process.exitCode = 1;
  }
}

function runOneChild({ cwd, timeoutMs, claudeBin }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, "--child"], {
      cwd,
      env: {
        ...process.env,
        BENCH_CWD: cwd,
        BENCH_TIMEOUT_MS: String(timeoutMs),
        ...(claudeBin ? { BENCH_CLAUDE_BIN: claudeBin } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill("SIGKILL");
      },
      timeoutMs * 2 + 5_000
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: "benchmark child timed out" });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({
          ok: false,
          error: `benchmark child exited with code ${code}; stderr bytes=${Buffer.byteLength(stderr)}`
        });
      }
    });
  });
}

function blockingPrompt() {
  let finish;
  let closed = false;
  return {
    close() {
      closed = true;
      finish?.({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
        return() {
          closed = true;
          finish?.({ done: true, value: undefined });
          return Promise.resolve({ done: true, value: undefined });
        }
      };
    }
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded ${timeoutMs}ms`)),
        timeoutMs
      );
    })
  ]).finally(() => clearTimeout(timer));
}

function modelCount(value) {
  return Array.isArray(value?.models) ? value.models.length : 0;
}

function summarize(values) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  return {
    min: rounded(sorted[0]),
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    max: rounded(sorted.at(-1))
  };
}

function percentile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}
