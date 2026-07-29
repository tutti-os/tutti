#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const defaultPort = 9223;
export const defaultTraceCategories = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "toplevel",
  "blink.user_timing",
  "loading",
  "v8",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.cpu_profiler.hires",
  "disabled-by-default-renderer.scheduler"
].join(",");

if (isMainModule()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const port = positiveInteger(options.port, "--port");
  const durationMs =
    options.duration == null
      ? null
      : Math.round(positiveNumber(options.duration, "--duration") * 1000);
  const outputPath = resolve(
    expandHome(options.output ?? defaultOutputPath(new Date()))
  );
  const categories = options.categories ?? defaultTraceCategories;
  if (durationMs == null && !process.stdin.isTTY) {
    throw new Error("stdin is not interactive; pass --duration <seconds>");
  }

  const websocketUrl = await resolveBrowserWebSocketUrl(port);
  await mkdir(dirname(outputPath), { recursive: true });

  const client = await CdpClient.connect(websocketUrl);
  try {
    log(`connected ${websocketUrl}`);
    log(`writing ${outputPath}`);
    log(`categories ${categories}`);

    await client.send("Tracing.start", {
      categories,
      options: "sampling-frequency=10000",
      transferMode: "ReturnAsStream"
    });

    log("recording started");
    if (durationMs == null) {
      log("press Enter to stop");
      await waitForEnter();
    } else {
      log(`stopping after ${(durationMs / 1000).toFixed(1)}s`);
      await delay(durationMs);
    }

    const complete = client.waitForEvent("Tracing.tracingComplete");
    await client.send("Tracing.end");
    const event = await complete;
    const stream = event.params?.stream;
    if (!stream) {
      throw new Error(
        "Tracing.tracingComplete did not include a stream handle"
      );
    }

    const bytes = await writeStreamToFile(client, stream, outputPath);
    log(`saved ${outputPath} (${formatBytes(bytes)})`);
  } finally {
    client.close();
  }
}

export async function resolveBrowserWebSocketUrl(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const version = await fetchJson(`${baseUrl}/json/version`).catch((error) => {
    throw new Error(
      `cannot reach Electron CDP at ${baseUrl}: ${error.message}\n` +
        "Launch with: TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT=9223 TUTTI_ELECTRON_JS_FLAGS=--max-old-space-size=8192 VITE_TUTTI_WHY_DID_YOU_RENDER=0 make dev-gui"
    );
  });
  if (typeof version.webSocketDebuggerUrl === "string") {
    return version.webSocketDebuggerUrl;
  }

  const targets = await fetchJson(`${baseUrl}/json/list`);
  const pageTarget = Array.isArray(targets)
    ? targets.find(
        (target) =>
          target?.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string"
      )
    : null;
  if (pageTarget) {
    return pageTarget.webSocketDebuggerUrl;
  }

  throw new Error(`no browser or page websocket found at ${baseUrl}`);
}

export async function resolvePageWebSocketUrl(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const pageTarget = Array.isArray(targets)
    ? targets.find(
        (target) =>
          target?.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string"
      )
    : null;
  if (!pageTarget) {
    throw new Error(`no page websocket found at http://127.0.0.1:${port}`);
  }
  return pageTarget.webSocketDebuggerUrl;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return await response.json();
}

export async function writeStreamToFile(client, stream, outputPath) {
  const file = createWriteStream(outputPath, { flags: "w" });
  let bytes = 0;

  try {
    while (true) {
      const result = await client.send("IO.read", { handle: stream });
      const data = String(result.data ?? "");
      if (data.length > 0) {
        const buffer = Buffer.from(
          data,
          result.base64Encoded ? "base64" : "utf8"
        );
        bytes += buffer.byteLength;
        if (!file.write(buffer)) {
          await once(file, "drain");
        }
      }
      if (result.eof) {
        break;
      }
    }
  } finally {
    await client.send("IO.close", { handle: stream }).catch(() => {});
    await new Promise((resolveClose, rejectClose) => {
      file.end((error) => {
        if (error) {
          rejectClose(error);
        } else {
          resolveClose();
        }
      });
    });
  }

  return bytes;
}

export class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    const client = new CdpClient(socket);
    await onceSocketOpen(socket);
    return client;
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.eventListeners = new Map();

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      const error = new Error("CDP websocket closed");
      for (const { reject } of this.pending.values()) {
        reject(error);
      }
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
    });
    this.socket.send(payload);
    return promise;
  }

  waitForEvent(method) {
    return new Promise((resolveEvent) => {
      const waiters = this.eventWaiters.get(method) ?? [];
      waiters.push(resolveEvent);
      this.eventWaiters.set(method, waiters);
    });
  }

  subscribe(method, listener) {
    const listeners = this.eventListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
    };
  }

  close() {
    this.socket.close();
  }

  handleMessage(raw) {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.from(raw instanceof ArrayBuffer ? raw : []).toString("utf8");
    const message = JSON.parse(text);

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `${message.error.message ?? "CDP error"} (${message.error.code ?? "unknown"})`
          )
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      const listeners = this.eventListeners.get(message.method);
      for (const listener of listeners ?? []) {
        listener(message);
      }
      const waiters = this.eventWaiters.get(message.method);
      if (!waiters?.length) {
        return;
      }
      this.eventWaiters.set(message.method, []);
      for (const resolveEvent of waiters) {
        resolveEvent(message);
      }
    }
  }
}

function parseArgs(argv) {
  const options = {
    port: String(defaultPort)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--port") {
      options.port = requiredValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--duration") {
      options.duration = requiredValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      options.output = requiredValue(argv, (index += 1), arg);
      continue;
    }
    if (arg === "--categories") {
      options.categories = requiredValue(argv, (index += 1), arg);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positiveInteger(value, option) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return number;
}

function positiveNumber(value, option) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return number;
}

function defaultOutputPath(date) {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");
  return join(homedir(), "Downloads", `TuttiTrace-${stamp}.json`);
}

function expandHome(path) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function waitForEnter() {
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolveEnter) => {
    process.stdin.once("data", () => {
      resolveEnter();
    });
  });
}

function once(emitter, eventName) {
  return new Promise((resolveOnce) => {
    emitter.once(eventName, resolveOnce);
  });
}

function onceSocketOpen(socket) {
  return new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener(
      "error",
      () => rejectOpen(new Error("CDP websocket connection failed")),
      { once: true }
    );
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function isMainModule() {
  return import.meta.url === `file://${process.argv[1]}`;
}

function log(message) {
  process.stderr.write(`[capture-electron-trace] ${message}\n`);
}

function printUsage() {
  process.stdout.write(`Capture an Electron performance trace through CDP.

Usage:
  pnpm trace:desktop -- --duration 15
  pnpm trace:desktop -- --output ~/Downloads/tutti-trace.json

Options:
  --port <port>           CDP remote debugging port. Default: ${defaultPort}
  --duration <seconds>    Stop automatically after this many seconds.
  -o, --output <path>     Output trace JSON path. Default: ~/Downloads/TuttiTrace-<timestamp>.json
  --categories <list>     Comma-separated CDP trace categories.
  -h, --help              Show this help.

Launch Tutti first:
  TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT=9223 TUTTI_ELECTRON_JS_FLAGS=--max-old-space-size=8192 VITE_TUTTI_WHY_DID_YOU_RENDER=0 make dev-gui
`);
}
