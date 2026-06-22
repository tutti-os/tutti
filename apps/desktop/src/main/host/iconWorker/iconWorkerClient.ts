import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  ICON_WORKER_ROLE,
  ICON_WORKER_ROLE_ENV,
  ICON_WORKER_STDOUT_PREFIX,
  type IconWorkerMode,
  type IconWorkerRequestMessage,
  type IconWorkerResponseMessage
} from "./iconWorkerProtocol.ts";

const requestTimeoutMs = 10_000;

export interface IconWorkerIconRequest {
  mode: IconWorkerMode;
  path: string;
  sizePx: number;
}

interface QueuedRequest {
  key: string;
  message: IconWorkerRequestMessage;
  resolve: (bytes: Buffer | null) => void;
}

interface InFlightRequest extends QueuedRequest {
  timer: ReturnType<typeof setTimeout>;
}

let child: ChildProcess | null = null;
let reader: Interface | null = null;
let nextRequestId = 1;
let starting = false;
const queue: QueuedRequest[] = [];
let inFlight: InFlightRequest | null = null;
// Inputs that crashed (or hung) the worker. Skipped for the rest of the session
// so one malformed file never causes a crash/respawn loop.
const poisonedKeys = new Set<string>();

// Resolve a single icon by handing the native work to the disposable worker
// process. Returns the PNG bytes, or `null` when no icon could be produced —
// including when the worker died on this input — so callers fall back cleanly.
export function requestWorkerIconPngBytes(
  request: IconWorkerIconRequest
): Promise<Buffer | null> {
  const key = `${request.mode}:${request.path}`;
  if (poisonedKeys.has(key)) {
    return Promise.resolve(null);
  }
  // A worker would only spawn another worker by mistake; never recurse.
  if (process.env[ICON_WORKER_ROLE_ENV] === ICON_WORKER_ROLE) {
    return Promise.resolve(null);
  }

  return new Promise<Buffer | null>((resolve) => {
    queue.push({
      key,
      message: {
        id: nextRequestId++,
        mode: request.mode,
        path: request.path,
        sizePx: request.sizePx
      },
      resolve
    });
    void pump();
  });
}

async function pump(): Promise<void> {
  if (inFlight || starting || queue.length === 0) {
    return;
  }
  starting = true;
  let worker: ChildProcess | null;
  try {
    worker = await ensureWorker();
  } finally {
    starting = false;
  }
  if (inFlight || queue.length === 0) {
    return;
  }
  if (!worker?.stdin) {
    // Worker unavailable: drain the queue with fallbacks.
    for (const queued of queue.splice(0)) {
      queued.resolve(null);
    }
    return;
  }

  const next = queue.shift();
  if (!next) {
    return;
  }
  const timer = setTimeout(() => {
    poisonedKeys.add(next.key);
    finishInFlight(null);
    restartWorker();
  }, requestTimeoutMs);
  inFlight = { ...next, timer };

  try {
    worker.stdin.write(`${JSON.stringify(next.message)}\n`);
  } catch {
    finishInFlight(null);
    restartWorker();
  }
}

function finishInFlight(bytes: Buffer | null): void {
  if (!inFlight) {
    return;
  }
  clearTimeout(inFlight.timer);
  inFlight.resolve(bytes);
  inFlight = null;
}

async function ensureWorker(): Promise<ChildProcess | null> {
  if (child) {
    return child;
  }
  try {
    // Re-launch this same app binary in worker mode. In dev the app dir must be
    // passed to the Electron binary; packaged binaries relaunch themselves.
    const { app } = await import("electron");
    const args = app.isPackaged ? [] : [app.getAppPath()];
    const spawned = spawn(process.execPath, args, {
      env: { ...process.env, [ICON_WORKER_ROLE_ENV]: ICON_WORKER_ROLE },
      stdio: ["pipe", "pipe", "inherit"]
    });
    spawned.on("exit", handleWorkerGone);
    spawned.on("error", handleWorkerGone);

    if (spawned.stdout) {
      const lineReader = createInterface({ input: spawned.stdout });
      lineReader.on("line", handleStdoutLine);
      reader = lineReader;
    }
    child = spawned;
    return spawned;
  } catch {
    child = null;
    reader = null;
    return null;
  }
}

function handleStdoutLine(line: string): void {
  if (!line.startsWith(ICON_WORKER_STDOUT_PREFIX)) {
    return;
  }
  let message: IconWorkerResponseMessage;
  try {
    message = JSON.parse(
      line.slice(ICON_WORKER_STDOUT_PREFIX.length)
    ) as IconWorkerResponseMessage;
  } catch {
    return;
  }
  if (!inFlight || inFlight.message.id !== message.id) {
    return;
  }
  const bytes = message.pngBase64
    ? Buffer.from(message.pngBase64, "base64")
    : null;
  finishInFlight(bytes);
  void pump();
}

function handleWorkerGone(): void {
  reader?.close();
  reader = null;
  child = null;
  // Whatever request was in flight is the prime suspect for the crash; poison it
  // so we never feed it back to a fresh worker.
  if (inFlight) {
    poisonedKeys.add(inFlight.key);
    finishInFlight(null);
  }
  void pump();
}

function restartWorker(): void {
  const dying = child;
  child = null;
  reader?.close();
  reader = null;
  if (dying) {
    dying.removeListener("exit", handleWorkerGone);
    dying.removeListener("error", handleWorkerGone);
    dying.kill();
  }
  void pump();
}
