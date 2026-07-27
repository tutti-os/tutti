import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const server = await createServer({
  configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
  logLevel: "error",
  root: fixtureRoot,
  server: {
    host: "127.0.0.1",
    port: 0
  }
});

try {
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const entrySource = await fetchText(`${origin}/src/main.ts`);
  const optimizedModulePath = matchFirst(
    entrySource,
    /from\s+["']([^"']*@tutti-os_workspace-file-manager[^"']*)["']/u,
    "optimized workspace-file-manager module"
  );
  const optimizedSource = await fetchText(
    new URL(optimizedModulePath, origin).href
  );
  assert.doesNotMatch(
    optimizedSource,
    /workspace-(?:archive|folder)-fallback\.png/u
  );
  assert.match(optimizedSource, /FileArchiveIcon/u);
  assert.match(optimizedSource, /FolderFilledIcon/u);
} finally {
  await server.close();
}

async function fetchText(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} should be served`);
  return response.text();
}

function matchFirst(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match?.[1], `expected ${label}`);
  return match[1];
}
