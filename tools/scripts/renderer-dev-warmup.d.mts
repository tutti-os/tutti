import type { Plugin, ViteDevServer } from "vite";

export interface RendererDevWarmupOptions {
  concurrency?: number;
  entryUrls?: string[];
}

export function warmRendererModuleGraph(
  server: ViteDevServer,
  options?: RendererDevWarmupOptions
): Promise<number>;

export function waitForRendererWarmupPlugin(
  options?: RendererDevWarmupOptions
): Plugin;
