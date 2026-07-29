import assert from "node:assert/strict";
import test from "node:test";
import {
  waitForRendererWarmupPlugin,
  warmRendererModuleGraph
} from "./renderer-dev-warmup.mjs";

test("renderer warmup transforms each statically reachable module once", async () => {
  const modules = createTransformedModules({
    "/src/lazy.tsx": "",
    "/src/main.tsx": `
      import "/src/shared.ts";
      import { view } from "/src/view.tsx";
    `,
    "/src/shared.ts": "",
    "/src/view.tsx": `
      import("/src/lazy.tsx");
      export { shared } from "/src/shared.ts";
    `
  });
  const transformedUrls = [];

  const transformedModuleCount = await warmRendererModuleGraph(
    {
      async transformRequest(url) {
        transformedUrls.push(url);
        return { code: modules.get(url) ?? "" };
      }
    },
    { concurrency: 2 }
  );

  assert.equal(transformedModuleCount, 3);
  assert.deepEqual(
    new Set(transformedUrls),
    new Set(["/src/main.tsx", "/src/shared.ts", "/src/view.tsx"])
  );
});

test("renderer warmup plugin waits for transforms after the server listens", async () => {
  const events = [];
  const server = {
    config: {
      logger: {
        info(message) {
          events.push(message);
        }
      }
    },
    async listen() {
      events.push("listen");
      return server;
    },
    async transformRequest(url) {
      events.push(`transform:${url}`);
      return { code: "" };
    }
  };

  const plugin = waitForRendererWarmupPlugin();
  plugin.configureServer(server);
  const result = await server.listen();

  assert.equal(result, server);
  assert.equal(events[0], "listen");
  assert.equal(events[2], "transform:/src/main.tsx");
  assert.match(
    events.at(-1),
    /^renderer warmup completed in \d+ms \(1 modules\)$/
  );
});

test("renderer warmup rejects invalid concurrency", async () => {
  await assert.rejects(
    warmRendererModuleGraph(
      {
        async transformRequest() {
          return { code: "" };
        }
      },
      { concurrency: 0 }
    ),
    /positive integer/
  );
});

function createTransformedModules(codeByUrl) {
  return new Map(Object.entries(codeByUrl));
}
