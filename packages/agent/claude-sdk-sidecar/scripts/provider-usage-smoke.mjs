#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const provider = option("--provider", "all");
const timeoutMs = Number(option("--timeout-ms", "30000"));
if (!new Set(["all", "codex", "claude"]).has(provider)) {
  throw new Error("--provider must be all, codex, or claude");
}

const results = {};
if (provider !== "claude") results.codex = await safely(probeCodex);
if (provider !== "codex") results.claude = await safely(probeClaude);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (Object.values(results).some((result) => !result.ok)) process.exitCode = 1;

async function probeCodex() {
  const child = spawn(
    process.env.CODEX_EXECUTABLE || "codex",
    ["-c", 'service_tier="fast"', "app-server"],
    { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "ignore"] }
  );
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error)
      waiter.reject(new Error("Codex JSON-RPC request failed"));
    else waiter.resolve(message.result);
  });
  const call = (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return bounded(response, `${method} timed out`);
  };
  try {
    await call("initialize", {
      clientInfo: {
        name: "tutti-provider-usage-smoke",
        title: "Tutti Provider Usage Smoke",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: true }
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const response = await call("account/rateLimits/read", null);
    const limits = object(response?.rateLimits) || object(response);
    return {
      protocol: "codex-app-server",
      method: "account/rateLimits/read",
      planType: scalar(limits?.planType),
      primary: windowSummary(limits?.primary),
      secondary: windowSummary(limits?.secondary)
    };
  } finally {
    lines.close();
    child.stdin.end();
    setTimeout(() => child.kill("SIGTERM"), 500).unref();
  }
}

async function probeClaude() {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(new URL("../src/main.ts", import.meta.url))
    ],
    { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "ignore"] }
  );
  const lines = createInterface({ input: child.stdout });
  const response = new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.id !== "usage-smoke") return;
      if (event.type === "error")
        reject(new Error("Claude usage probe failed"));
      else resolve(event.payload);
    });
    child.once("error", reject);
  });
  child.stdin.end(
    `${JSON.stringify({
      version: 10,
      id: "usage-smoke",
      type: "probe_usage",
      payload: { cwd: process.cwd(), env: {} }
    })}\n`
  );
  try {
    const usage = await bounded(response, "Claude SDK get_usage timed out");
    return {
      protocol: "claude-agent-sdk-sidecar",
      method: "get_usage",
      subscriptionType: scalar(usage?.subscriptionType),
      rateLimitsAvailable: usage?.rateLimitsAvailable === true,
      windows: Object.fromEntries(
        ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]
          .filter((key) => usage?.rateLimits?.[key])
          .map((key) => [key, windowSummary(usage.rateLimits[key])])
      )
    };
  } finally {
    lines.close();
    child.kill("SIGTERM");
  }
}

function windowSummary(value) {
  const item = object(value);
  if (!item) return null;
  return {
    utilization: number(item.utilization ?? item.usedPercent),
    resetsAt: scalar(item.resets_at ?? item.resetsAt),
    windowDurationMinutes: number(item.windowDurationMins)
  };
}

async function safely(probe) {
  const startedAt = Date.now();
  try {
    const result = await probe();
    return { ok: true, durationMs: Date.now() - startedAt, ...result };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error:
        error instanceof Error ? error.message.slice(0, 500) : "unknown error"
    };
  }
}

function bounded(promise, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function scalar(value) {
  return ["string", "number", "boolean"].includes(typeof value) ? value : null;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}
