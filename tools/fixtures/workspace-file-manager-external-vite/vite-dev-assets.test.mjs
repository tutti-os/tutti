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
    /\.vite\/deps\/assets\/workspace-(?:archive|folder)-fallback\.png/u
  );

  for (const fallbackKind of ["archive", "folder"]) {
    const assetModulePath = matchFirst(
      optimizedSource,
      new RegExp(
        `["']([^"']*workspace-${fallbackKind}-fallback\\.png\\?[^"']*)["']`,
        "u"
      ),
      `${fallbackKind} fallback asset module`
    );
    const assetModuleSource = await fetchText(
      new URL(assetModulePath, origin).href
    );
    const assetPath = matchFirst(
      assetModuleSource,
      /export default\s+["']([^"']+)["']/u,
      `${fallbackKind} fallback asset URL`
    );
    const assetResponse = await fetch(new URL(assetPath, origin));
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get("content-type"), "image/png");
  }
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
