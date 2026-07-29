import { readFile } from "node:fs/promises";

import { defineConfig, type Options } from "tsup";

import { cssSafeSvgDataUrl } from "./build/cssSafeSvgDataUrl";
import { agentGUIBuildEntries } from "./build/agentGuiBuildEntries";

const cssSafeSvgDataUrlPlugin: NonNullable<Options["esbuildPlugins"]>[number] =
  {
    name: "css-safe-svg-data-url",
    setup(build) {
      build.onLoad({ filter: /\.svg$/ }, async ({ path }) => {
        const svg = await readFile(path, "utf8");
        return {
          contents: `export default ${JSON.stringify(cssSafeSvgDataUrl(svg))};`,
          loader: "js"
        };
      });
    }
  };

export default defineConfig({
  clean: true,
  entry: agentGUIBuildEntries,
  external: ["react", "react-dom"],
  esbuildPlugins: [cssSafeSvgDataUrlPlugin],
  format: ["esm"],
  loader: {
    ".png": "dataurl"
  },
  sourcemap: true
});
