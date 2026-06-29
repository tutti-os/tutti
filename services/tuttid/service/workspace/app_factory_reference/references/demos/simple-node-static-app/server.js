const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const host = process.env.TUTTI_APP_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.TUTTI_APP_PORT || "", 10);
const packageDir = process.env.TUTTI_APP_PACKAGE_DIR;
const dataDir = process.env.TUTTI_APP_DATA_DIR;

if (!Number.isInteger(port)) {
  throw new Error("TUTTI_APP_PORT is required");
}
if (!packageDir || !dataDir) {
  throw new Error("TUTTI_APP_PACKAGE_DIR and TUTTI_APP_DATA_DIR are required");
}

function writeJson(response, payload, statusCode = 200) {
  const data = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.byteLength
  });
  response.end(data);
}

function serveFile(response, relativePath, contentType) {
  const filePath = path.join(packageDir, relativePath);
  const data = fs.readFileSync(filePath);
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": data.byteLength
  });
  response.end(data);
}

function readState() {
  fs.mkdirSync(dataDir, { recursive: true });
  const statePath = path.join(dataDir, "state.json");
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(statePath, JSON.stringify({ items: [] }), "utf8");
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    writeJson(response, { ok: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/state") {
    writeJson(response, readState());
    return;
  }
  if (request.method === "POST" && url.pathname === "/tutti/cli/ping") {
    writeJson(response, {
      kind: "json",
      value: {
        ok: true,
        appId: process.env.TUTTI_APP_ID || ""
      }
    });
    return;
  }
  if (request.method === "GET") {
    serveFile(response, "static/index.html", "text/html; charset=utf-8");
    return;
  }
  writeJson(response, { error: "not_found" }, 404);
});

server.listen(port, host);
