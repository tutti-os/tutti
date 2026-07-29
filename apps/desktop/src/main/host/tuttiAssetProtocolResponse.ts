/**
 * Apply only after the request URL resolves through tuttiAssetProtocolAssets.
 * These responses contain credentialless bundled images; wildcard CORS keeps
 * anonymous image loads usable as WebGL textures in file and dev renderers.
 */
export function createTuttiAssetProtocolResponse(source: Response): Response {
  const headers = new Headers(source.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(source.body, {
    headers,
    status: source.status,
    statusText: source.statusText
  });
}
