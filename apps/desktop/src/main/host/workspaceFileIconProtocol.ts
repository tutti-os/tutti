import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import {
  workspaceFileIconProtocolScheme,
  type WorkspaceFileIconCacheStore
} from "./workspaceFileIconCacheStore.ts";

let protocolHandled = false;

export function registerWorkspaceFileIconProtocol(
  store: WorkspaceFileIconCacheStore
): void {
  if (protocolHandled) {
    return;
  }
  protocolHandled = true;
  protocol.handle(workspaceFileIconProtocolScheme, async (request) => {
    const resolved = await store.resolveProtocolUrl(request.url);
    if (!resolved) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(resolved.filePath).href);
  });
}
