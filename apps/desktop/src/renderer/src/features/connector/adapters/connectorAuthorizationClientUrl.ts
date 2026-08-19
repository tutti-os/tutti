const connectorAuthorizationStartPathPrefix = "/connector-authorization/start/";
const desktopClientQuery = "desktop_client";
const openAppUrlQuery = "openAppUrl";

export function addTuttiDesktopClientToConnectorAuthorizationUrl(
  rawUrl: string,
  isDevelopment: boolean
): string {
  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.pathname.startsWith(connectorAuthorizationStartPathPrefix)
    ) {
      return rawUrl;
    }
    url.searchParams.set(desktopClientQuery, "tutti");
    url.searchParams.set(
      openAppUrlQuery,
      isDevelopment ? "tutti-dev://open" : "tutti://open"
    );
    return url.toString();
  } catch {
    return rawUrl;
  }
}
