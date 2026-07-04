import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  resolveDesktopDaemonBaseUrl,
  type DesktopDaemonEndpoint
} from "./paths";

const daemonRequestTimeoutMs = 5_000;

interface RequestOptions {
  body?: string;
  headers: Headers;
  method: string;
  path: string;
}

export function createDesktopDaemonFetch(
  getEndpoint: () => DesktopDaemonEndpoint
  // oxlint-disable-next-line no-restricted-globals -- fetch-shaped transport to the local daemon, not outbound
): typeof fetch {
  return async (
    input: URL | RequestInfo,
    init?: RequestInit
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    return requestOverHttp(resolveDesktopDaemonBaseUrl(getEndpoint()), {
      body: await encodeRequestBody(request),
      headers: request.headers,
      method: request.method,
      path: `${url.pathname}${url.search}`
    });
  };
}

function requestOverHttp(
  baseUrl: string,
  options: RequestOptions
): Promise<Response> {
  const url = new URL(options.path, baseUrl);
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        timeout: daemonRequestTimeoutMs,
        headers: requestHeaders(options.headers, options.body)
      },
      (response) => {
        collectResponse(response, reject, resolve);
      }
    );

    request.on("timeout", () => {
      request.destroy(
        new Error(`Daemon request timed out after ${daemonRequestTimeoutMs}ms.`)
      );
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

function collectResponse(
  response: NodeJS.ReadableStream & {
    headers: IncomingHttpHeaders;
    statusCode?: number;
    statusMessage?: string;
    setEncoding(encoding: BufferEncoding): void;
  },
  reject: (reason?: unknown) => void,
  resolve: (value: Response | PromiseLike<Response>) => void
): void {
  let body = "";
  response.setEncoding("utf8");

  response.on("data", (chunk: string) => {
    body += chunk;
  });

  response.on("error", reject);
  response.on("end", () => {
    resolve(
      new Response(body, {
        headers: responseHeaders(response.headers),
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? ""
      })
    );
  });
}

async function encodeRequestBody(
  request: Request
): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const body = await request.text();
  return body || undefined;
}

function requestHeaders(
  headers: Headers,
  body: string | undefined
): Record<string, string> {
  const result = Object.fromEntries(headers.entries());

  if (!result.accept) {
    result.accept = "application/json";
  }

  if (!body) {
    delete result["content-length"];
    return result;
  }

  result["content-length"] = Buffer.byteLength(body).toString();
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        result.append(key, item);
      }
      continue;
    }

    result.set(key, value);
  }

  return result;
}
