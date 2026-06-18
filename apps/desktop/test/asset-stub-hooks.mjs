// Module customization hooks for `node --test`.
//
// Renderer modules statically import static assets (png/svg/css/...), which the
// bundler resolves at build time. Node's test runner has no such bundler, so a
// real asset import throws ERR_UNKNOWN_FILE_EXTENSION. Stub asset imports with a
// string URL so any module chain a test loads stays importable.
const ASSET_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".avif",
  ".ico",
  ".css",
  ".woff",
  ".woff2"
];

export async function load(url, context, nextLoad) {
  if (ASSET_EXTENSIONS.some((ext) => url.endsWith(ext))) {
    return {
      format: "module",
      shortCircuit: true,
      source: `export default ${JSON.stringify(url)};`
    };
  }
  return nextLoad(url, context);
}
