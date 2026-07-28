import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import { loadComponentsMetadata } from "./components.js";
import {
  getPackageRoot,
  getSyncFile,
  getSyncFiles,
  hashFile,
  isAllowedSyncPath,
  normalizeSyncPath,
  resolveAllowedFile
} from "./fileManifest.js";
import type { UISystemDevEvent, UISystemDevManifest } from "./protocol.js";

const packageName = "@tutti-os/ui-system";
const host = process.env.UI_SYSTEM_DEV_SERVER_HOST ?? "127.0.0.1";
const port = Number(process.env.UI_SYSTEM_DEV_SERVER_PORT ?? 4100);

const manifest: UISystemDevManifest = {
  packageName,
  version: "0.1.0",
  entrypoints: {
    ".": "src/index.ts",
    "./components": "src/components/index.ts",
    "./icons": "src/icons/index.ts",
    "./native": "src/native/index.ts",
    "./native.css": "src/styles/native.css",
    "./styles.css": "src/styles/index.css",
    "./utils": "src/lib/utils.ts"
  },
  tailwindSourceRoot: "src",
  componentsMetadata: "src/metadata/components.json"
};

const server = createServer((request, response) => {
  void handleRequest(request, response);
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  if (request.method !== "GET" || request.url === undefined) {
    sendNotFound(response);
    return;
  }

  const rawPathname = request.url.split(/[?#]/, 1)[0] ?? "/";
  const url = new URL(request.url, `http://${host}:${port}`);

  try {
    if (url.pathname === "/health") {
      sendJson(response, { ok: true, packageName });
      return;
    }

    if (url.pathname === "/manifest") {
      sendJson(response, manifest);
      return;
    }

    if (rawPathname === "/files") {
      sendJson(response, await getSyncFiles());
      return;
    }

    if (rawPathname.startsWith("/files/")) {
      await sendFile(response, rawPathname.slice("/files/".length));
      return;
    }

    if (url.pathname === "/components") {
      sendJson(response, await loadComponentsMetadata());
      return;
    }

    sendNotFound(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendJson(response, { error: message }, 500);
  }
}

const events = new WebSocketServer({ noServer: true });
const watchers: FSWatcher[] = [];

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (url.pathname !== "/events") {
    socket.destroy();
    return;
  }

  events.handleUpgrade(request, socket, head, (websocket) => {
    events.emit("connection", websocket, request);
  });
});

server.listen(port, host, () => {
  console.log(
    `@tutti-os/ui-system dev server listening on http://${host}:${port}`
  );
});

startWatching();

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function sendFile(
  response: ServerResponse,
  requestPath: string
): Promise<void> {
  const syncPath = normalizeSyncPath(requestPath);
  const absolutePath = syncPath === null ? null : resolveAllowedFile(syncPath);

  if (syncPath === null || absolutePath === null) {
    sendNotFound(response);
    return;
  }

  try {
    const file = await getSyncFile(syncPath);

    if (file === null) {
      sendNotFound(response);
      return;
    }

    const bytes = await readFile(absolutePath);
    response.writeHead(200, {
      "Content-Length": bytes.byteLength,
      "Content-Type": contentTypeForPath(syncPath)
    });
    response.end(bytes);
  } catch {
    sendNotFound(response);
  }
}

function sendJson(
  response: ServerResponse,
  payload: unknown,
  statusCode = 200
): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(body);
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, { error: "Not found" }, 404);
}

function contentTypeForPath(syncPath: string): string {
  if (syncPath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  if (syncPath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (syncPath.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function startWatching(): void {
  watchPath(path.join(getPackageRoot(), "src"), true);
  watchPath(path.join(getPackageRoot(), "agent"), true);
  watchPath(getPackageRoot(), false);
}

function watchPath(absolutePath: string, recursive: boolean): void {
  try {
    watchers.push(
      watch(absolutePath, { recursive }, (_eventType, filename) => {
        if (filename === null) {
          return;
        }

        void publishPathEvent(
          path.relative(getPackageRoot(), path.join(absolutePath, filename))
        );
      })
    );
  } catch {
    // Watching is best-effort for local development; HTTP endpoints remain usable.
  }
}

async function publishPathEvent(syncPathInput: string): Promise<void> {
  const syncPath = normalizeSyncPath(syncPathInput);

  if (syncPath === null || !isAllowedSyncPath(syncPath)) {
    return;
  }

  if (syncPath === "package.json") {
    broadcast({ type: "manifestChanged" });
  }

  if (syncPath === "src/metadata/components.json") {
    broadcast({ type: "componentsChanged" });
  }

  const absolutePath = resolveAllowedFile(syncPath);

  if (absolutePath === null) {
    return;
  }

  try {
    broadcast({
      type: "fileChanged",
      path: syncPath,
      hash: await hashFile(absolutePath)
    });
  } catch {
    broadcast({ type: "fileDeleted", path: syncPath });
  }
}

function broadcast(event: UISystemDevEvent): void {
  const payload = JSON.stringify(event);

  for (const client of events.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function stop(): void {
  for (const watcher of watchers) {
    watcher.close();
  }

  events.close();
  server.close(() => {
    process.exit(0);
  });
}
