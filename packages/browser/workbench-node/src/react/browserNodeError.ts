import type { ReactNode } from "react";
import type { BrowserNodeFeature } from "../core/feature.ts";
import type { BrowserNodeRuntimeError } from "../core/types.ts";

export interface BrowserNodeErrorRenderContext {
  error: BrowserNodeRuntimeError;
  message: string;
  navigate(url: string): Promise<void>;
  nodeId: string;
  reload(): Promise<void>;
  status: string | null;
}

export type BrowserNodeLoadErrorView = "none" | "custom" | "default";

export function formatBrowserNodeErrorMessage(
  feature: Pick<BrowserNodeFeature, "i18n">,
  error: BrowserNodeRuntimeError
): string {
  switch (error.code) {
    case "invalid-url":
      return feature.i18n.t("errors.invalidUrl", error.params);
    case "navigation-failed":
      if (error.params && error.params.statusCode !== undefined) {
        return feature.i18n.t(
          "errors.navigationFailedWithStatus",
          error.params
        );
      }
      return feature.i18n.t("errors.navigationFailed", error.params);
    case "unsupported-protocol":
      return feature.i18n.t("errors.unsupportedProtocol", error.params);
    case "unsupported-url":
      return feature.i18n.t("errors.unsupportedUrl", error.params);
  }
}

export function formatBrowserNodeErrorStatus(
  feature: Pick<BrowserNodeFeature, "i18n">,
  error: BrowserNodeRuntimeError
): string | null {
  if (error.code !== "navigation-failed" || !error.params) {
    return null;
  }

  const statusCode = error.params.statusCode;
  if (typeof statusCode === "number") {
    return feature.i18n.t("errors.statusCode", { statusCode });
  }

  const errorCode = error.params.errorCode;
  if (typeof errorCode === "number") {
    return feature.i18n.t("errors.errorCode", { errorCode });
  }

  return null;
}

export function resolveBrowserNodeLoadErrorView(input: {
  customContent: ReactNode | null | undefined;
  hasError: boolean;
}): BrowserNodeLoadErrorView {
  if (!input.hasError) {
    return "none";
  }
  if (input.customContent != null && input.customContent !== false) {
    return "custom";
  }
  return "default";
}
