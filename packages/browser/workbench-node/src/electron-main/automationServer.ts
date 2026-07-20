import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";
import { isBrowserNodeAutomationTool } from "./automationRegistry.ts";
import type {
  BrowserNodeAutomationCallInput,
  BrowserNodeAutomationRegistry,
  BrowserNodeAutomationToolResult
} from "./automationTypes.ts";
import type { BrowserNodeElectronLogger } from "./types.ts";

const maximumRequestBytes = 1024 * 1024;
const genericRequestFailure = "BrowserNode automation request failed";
const notFoundMessage = "Not found";
const unauthorizedMessage = "Unauthorized";

export interface BrowserNodeAutomationListenerInfo {
  address: string;
  token: string;
  version: 1;
}

export interface BrowserNodeAutomationServer {
  readonly listenerInfo: BrowserNodeAutomationListenerInfo;
  dispose(): void;
}

export async function createBrowserNodeAutomationServer(input: {
  listenerInfoPath: string;
  logger?: BrowserNodeElectronLogger;
  registry: BrowserNodeAutomationRegistry;
}): Promise<BrowserNodeAutomationServer> {
  const listenerInfoPath = input.listenerInfoPath.trim();
  if (!listenerInfoPath) {
    throw new Error("BrowserNode automation listener info path is required");
  }
  const token = randomBytes(32).toString("base64url");
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, input.registry).catch(
      (error) => {
        input.logger?.warn?.("BrowserNode automation request failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        sendJson(response, 500, {
          error: { message: genericRequestFailure }
        });
      }
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error("BrowserNode automation server did not bind an address");
  }
  const listenerInfo: BrowserNodeAutomationListenerInfo = {
    address: `127.0.0.1:${address.port}`,
    token,
    version: 1
  };
  await writeListenerInfo(listenerInfoPath, listenerInfo);
  input.logger?.info?.("BrowserNode automation server listening", {
    address: listenerInfo.address,
    listenerInfoPath
  });

  let disposed = false;
  return {
    listenerInfo,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      server.close();
      void rm(listenerInfoPath, { force: true }).catch(() => undefined);
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  registry: BrowserNodeAutomationRegistry
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/v1/call") {
    sendJson(response, 404, { error: { message: notFoundMessage } });
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    sendJson(response, 401, { error: { message: unauthorizedMessage } });
    return;
  }

  let call: BrowserNodeAutomationCallInput;
  try {
    call = parseCall(await readRequestBody(request));
  } catch (error) {
    sendJson(response, 400, {
      error: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
    return;
  }

  try {
    const result = await registry.call(call);
    sendJson(response, 200, { result });
  } catch (error) {
    sendJson(response, 409, {
      error: {
        message: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) {
      throw new Error("BrowserNode automation request is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseCall(raw: string): BrowserNodeAutomationCallInput {
  const value = JSON.parse(raw) as Partial<BrowserNodeAutomationCallInput>;
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.workspaceId !== "string" ||
    typeof value.tool !== "string" ||
    !isBrowserNodeAutomationTool(value.tool) ||
    (value.args !== undefined &&
      (!value.args ||
        typeof value.args !== "object" ||
        Array.isArray(value.args)))
  ) {
    throw new Error("Invalid BrowserNode automation call");
  }
  return {
    agentSessionId:
      typeof value.agentSessionId === "string" ? value.agentSessionId : null,
    args: value.args ?? {},
    tool: value.tool,
    workspaceId: value.workspaceId
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value:
    | { error: { message: string } }
    | { result: BrowserNodeAutomationToolResult }
): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value));
}

async function writeListenerInfo(
  path: string,
  listenerInfo: BrowserNodeAutomationListenerInfo
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(listenerInfo)}\n`, {
    mode: 0o600
  });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
