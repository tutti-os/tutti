import { init, parse } from "es-module-lexer";

const defaultConcurrency = 8;
const defaultEntryUrls = ["/src/main.tsx"];

export async function warmRendererModuleGraph(
  server,
  { concurrency = defaultConcurrency, entryUrls = defaultEntryUrls } = {}
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Renderer warmup concurrency must be a positive integer.");
  }
  if (
    !Array.isArray(entryUrls) ||
    entryUrls.length === 0 ||
    entryUrls.some((entryUrl) => typeof entryUrl !== "string")
  ) {
    throw new Error("Renderer warmup entry URLs must be a non-empty array.");
  }

  await init;

  const queuedUrls = new Set(entryUrls);
  const pendingUrls = [...entryUrls];
  let transformedModuleCount = 0;

  while (pendingUrls.length > 0) {
    const batch = pendingUrls.splice(0, concurrency);
    const importedUrlGroups = await Promise.all(
      batch.map(async (url) => {
        const result = await server.transformRequest(url);
        transformedModuleCount += 1;

        if (!result?.code) {
          return [];
        }

        const [imports] = parse(result.code);
        return imports
          .filter((importedModule) => importedModule.d === -1)
          .map((importedModule) => importedModule.n)
          .filter((importedUrl) => typeof importedUrl === "string");
      })
    );

    for (const importedUrl of importedUrlGroups.flat()) {
      if (queuedUrls.has(importedUrl)) {
        continue;
      }
      queuedUrls.add(importedUrl);
      pendingUrls.push(importedUrl);
    }
  }

  return transformedModuleCount;
}

export function waitForRendererWarmupPlugin({
  concurrency = defaultConcurrency,
  entryUrls = defaultEntryUrls
} = {}) {
  return {
    name: "wait-for-renderer-warmup",
    apply: "serve",
    configureServer(server) {
      const listen = server.listen.bind(server);

      server.listen = async (...args) => {
        const result = await listen(...args);
        const startedAt = performance.now();
        server.config.logger.info(
          "warming renderer modules before Electron launch..."
        );
        const transformedModuleCount = await warmRendererModuleGraph(server, {
          concurrency,
          entryUrls
        });
        const durationMs = Math.round(performance.now() - startedAt);
        server.config.logger.info(
          `renderer warmup completed in ${durationMs}ms (${transformedModuleCount} modules)`
        );
        return result;
      };
    }
  };
}
