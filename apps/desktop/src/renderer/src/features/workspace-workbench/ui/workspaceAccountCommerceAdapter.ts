import type { AccountProductSummaryResponse } from "@tutti-os/client-tuttid-ts";

export interface WorkspaceAccountCommerceProjection {
  summary: AccountProductSummaryResponse | null;
  loading: boolean;
  dataUnavailable: boolean;
  commerceVisible: boolean;
  shouldRefresh: boolean;
}

export interface WorkspaceAccountMenuComposition {
  showCommerce: boolean;
  showSettings: boolean;
  showLogout: boolean;
}

export function projectWorkspaceAccountMenuComposition(input: {
  commerceEnabled: boolean;
  signedIn: boolean;
}): WorkspaceAccountMenuComposition {
  return {
    showCommerce: input.commerceEnabled && input.signedIn,
    showSettings: input.signedIn,
    showLogout: input.signedIn
  };
}

export function projectWorkspaceAccountCommerce(input: {
  enabled: boolean;
  summary: AccountProductSummaryResponse | null;
  loading: boolean;
  error: string | null;
}): WorkspaceAccountCommerceProjection {
  if (!input.enabled) {
    return {
      summary: null,
      loading: false,
      dataUnavailable: false,
      commerceVisible: false,
      shouldRefresh: false
    };
  }

  return {
    summary: input.summary,
    loading: input.loading,
    // Never project the daemon/client Error.message into renderer copy.
    // Diagnostics keep the raw error; the UI receives only a safe state bit.
    dataUnavailable:
      Boolean(input.error) || input.summary?.partial_error != null,
    commerceVisible: true,
    shouldRefresh: true
  };
}
