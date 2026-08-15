import {
  DefaultAuthorizationViewRenderer,
  type AuthorizationEmbeddedPageRendererProps,
  type AuthorizationViewRendererProps
} from "@tutti-os/connector-market/authorization";
import type { ComponentType, HTMLAttributes } from "react";

type AuthorizationWebviewProps = HTMLAttributes<HTMLElement> & {
  "data-tutti-authorization-webview": "true";
  partition: string;
  src: string;
};

const AuthorizationWebview =
  "webview" as unknown as ComponentType<AuthorizationWebviewProps>;

export function DesktopConnectorAuthorizationPage({
  flowId,
  url
}: AuthorizationEmbeddedPageRendererProps) {
  const partition = `tutti-authorization:${flowId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  return (
    <div className="h-[420px] min-h-0 overflow-hidden rounded-lg border border-[var(--border-1)] bg-white">
      <AuthorizationWebview
        key={url}
        className="block size-full border-0 bg-white"
        data-tutti-authorization-webview="true"
        partition={partition}
        src={url}
      />
    </div>
  );
}

export function DesktopConnectorAuthorizationRenderer(
  props: AuthorizationViewRendererProps
) {
  return (
    <DefaultAuthorizationViewRenderer
      {...props}
      embeddedPageRenderer={DesktopConnectorAuthorizationPage}
    />
  );
}
