import { pathToFileURL } from "node:url";
import { app, net, protocol, session, type Session } from "electron";
import { tuttiAssetProtocolScheme } from "../../shared/tuttiAssetProtocol.ts";
import { resolveTuttiAssetProtocolFilePath } from "./tuttiAssetProtocolResolver.ts";

let schemeRegistered = false;
const handledSessions = new WeakSet<Session>();

export function registerTuttiAssetProtocolScheme(): void {
  if (schemeRegistered) {
    return;
  }
  schemeRegistered = true;
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true
      },
      scheme: tuttiAssetProtocolScheme
    }
  ]);
}

export function registerTuttiAssetProtocol(): void {
  registerTuttiAssetProtocolForSession(session.defaultSession);
}

export function registerTuttiAssetProtocolForSession(
  electronSession: Session
): void {
  if (handledSessions.has(electronSession)) {
    return;
  }
  handledSessions.add(electronSession);
  electronSession.protocol.handle(tuttiAssetProtocolScheme, async (request) => {
    const filePath = resolveTuttiAssetProtocolFilePath(
      request.url,
      app.getAppPath()
    );
    if (!filePath) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
}
