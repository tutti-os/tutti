// Module customization hooks for `node --test`.
//
// Renderer modules statically import static assets (png/svg/css/...), which the
// bundler resolves at build time. Node's test runner has no such bundler, so a
// real asset import throws ERR_UNKNOWN_FILE_EXTENSION. Stub asset imports with a
// string URL so any module chain a test loads stays importable.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".css", "text/css"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

export async function load(url, context, nextLoad) {
  const assetUrl = new URL(url);
  const extension = extname(assetUrl.pathname).toLowerCase();
  const mimeType = ASSET_MIME_TYPES.get(extension);
  if (mimeType) {
    if (assetUrl.searchParams.has("inline")) {
      assetUrl.search = "";
      assetUrl.hash = "";
      const bytes = await readFile(fileURLToPath(assetUrl));
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(
          `data:${mimeType};base64,${bytes.toString("base64")}`
        )};`
      };
    }
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(url)};`
    };
  }
  return nextLoad(url, context);
}
