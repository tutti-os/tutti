import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "valtio";

import type { IConnectorMarketRoot } from "../../application/services/core/connectorMarketRoot.interface.ts";
import type {
  ConnectorAuthorizationDialogView,
  ConnectorManagementDialogView,
  ConnectorMarketViewState
} from "../../application/services/view/connectorMarketViewTypes.ts";
import { ConnectorMarketRootProvider } from "../ConnectorMarketServicesContext.tsx";
import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import { ConnectorMarketDialogs } from "./ConnectorMarketDialogs.tsx";

afterEach(cleanup);

const i18n = {
  has: () => true,
  t: (key: string) => key,
  tFirst: (keys: readonly string[]) => keys[0] ?? ""
} as ConnectorMarketI18nRuntime;

const authorizationDialog: ConnectorAuthorizationDialogView = {
  authorizationKind: "oauth2",
  authorizing: false,
  brokeredAuthorization: false,
  connectorKey: "gmail",
  description: "Gmail tools",
  displayName: "Gmail",
  iconUrl: "/gmail.png",
  kind: "authorization",
  pending: false,
  permissions: []
};

const managementDialog: ConnectorManagementDialogView = {
  canAuthorize: true,
  canUninstall: true,
  connectorKey: "gmail",
  description: "Gmail tools",
  details: [],
  displayName: "Gmail",
  iconUrl: "/gmail.png",
  kind: "management",
  permissions: []
};

function emptyView(
  dialog: ConnectorMarketViewState["dialog"]
): ConnectorMarketViewState {
  return {
    cardsByKey: {},
    catalogError: null,
    dialog,
    refreshing: false,
    sections: [],
    status: "ready"
  };
}

describe("ConnectorMarketDialogs", () => {
  it("closes the authorization dialog and shows only the success toast", async () => {
    const viewState = proxy(emptyView(authorizationDialog));
    const closeDialog = vi.fn(() => {
      viewState.dialog = null;
    });
    const onTryConnector = vi.fn();
    const root = {
      market: {
        beginAuthorization: vi.fn(async () => {
          viewState.dialog = managementDialog;
        }),
        dataStore: proxy({
          pendingUninstallNotificationsByOperationId: {}
        })
      },
      uiState: {
        closeDialog,
        dataStore: proxy({
          dialog: { connectorKey: "gmail", kind: "connector" },
          query: "",
          scope: {},
          started: true
        })
      },
      view: { dataStore: viewState }
    } as unknown as IConnectorMarketRoot;

    render(
      <ConnectorMarketRootProvider
        i18n={i18n}
        onTryConnector={onTryConnector}
        root={root}
      >
        <ConnectorMarketDialogs />
      </ConnectorMarketRootProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "actionAuthorize" }));

    expect(
      await screen.findByText("actionAuthorizeSuccess")
    ).toBeInTheDocument();
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "actionTry" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "actionDisconnect" })
    ).not.toBeInTheDocument();
    expect(onTryConnector).not.toHaveBeenCalled();
  });

  it("copies a pending device code and shows the success state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const viewState = proxy(
      emptyView({
        ...authorizationDialog,
        authorizing: true,
        pending: true,
        authorizationView: {
          protocol: "tutti.connector.authorization.view.v1",
          viewId: "github-device-code-1",
          view: {
            type: "device_code",
            verificationUrl: "https://github.com/login/device",
            userCode: "ABCD-EFGH"
          }
        }
      })
    );
    const root = {
      market: {
        dataStore: proxy({
          pendingUninstallNotificationsByOperationId: {}
        })
      },
      uiState: {
        dataStore: proxy({
          dialog: { connectorKey: "github-cli", kind: "connector" },
          query: "",
          scope: {},
          started: true
        })
      },
      view: { dataStore: viewState }
    } as unknown as IConnectorMarketRoot;

    render(
      <ConnectorMarketRootProvider i18n={i18n} root={root}>
        <ConnectorMarketDialogs />
      </ConnectorMarketRootProvider>
    );

    expect(screen.getByText("ABCD-EFGH")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "copyDeviceCode" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("ABCD-EFGH");
      expect(
        screen.getByRole("button", { name: "deviceCodeCopied" })
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "actionWaitingAuthorization" })
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "actionContinueAuthorization" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "cancel" })).toBeEnabled();
  });

  it("keeps the copy affordance when clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    const viewState = proxy(
      emptyView({
        ...authorizationDialog,
        authorizing: true,
        pending: true,
        authorizationView: {
          protocol: "tutti.connector.authorization.view.v1",
          viewId: "github-device-code-1",
          view: {
            type: "device_code",
            verificationUrl: "https://github.com/login/device",
            userCode: "ABCD-EFGH"
          }
        }
      })
    );
    const root = {
      market: {
        dataStore: proxy({
          pendingUninstallNotificationsByOperationId: {}
        })
      },
      uiState: {
        dataStore: proxy({
          dialog: { connectorKey: "github-cli", kind: "connector" },
          query: "",
          scope: {},
          started: true
        })
      },
      view: { dataStore: viewState }
    } as unknown as IConnectorMarketRoot;

    render(
      <ConnectorMarketRootProvider i18n={i18n} root={root}>
        <ConnectorMarketDialogs />
      </ConnectorMarketRootProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "copyDeviceCode" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    expect(
      screen.getByRole("button", { name: "copyDeviceCode" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "deviceCodeCopied" })
    ).not.toBeInTheDocument();
  });

  it("keeps one authorization action until the user finishes or closes it", async () => {
    const viewState = proxy(
      emptyView({
        ...authorizationDialog,
        authorizing: true,
        pending: true,
        authorizationView: {
          protocol: "tutti.connector.authorization.view.v1",
          viewId: "gmail-oauth",
          view: {
            type: "external_link",
            url: "https://accounts.google.com/o/oauth2/auth"
          }
        }
      })
    );
    const closeDialog = vi.fn();
    const beginAuthorization = vi.fn(async () => undefined);
    const cancelAuthorization = vi.fn(async () => undefined);
    const root = {
      market: {
        beginAuthorization,
        cancelAuthorization,
        dataStore: proxy({
          pendingUninstallNotificationsByOperationId: {}
        })
      },
      uiState: {
        closeDialog,
        dataStore: proxy({
          dialog: { connectorKey: "gmail", kind: "connector" },
          query: "",
          scope: {},
          started: true
        })
      },
      view: { dataStore: viewState }
    } as unknown as IConnectorMarketRoot;

    const { rerender } = render(
      <ConnectorMarketRootProvider i18n={i18n} root={root}>
        <ConnectorMarketDialogs />
      </ConnectorMarketRootProvider>
    );

    const waiting = screen.getByRole("button", {
      name: "actionWaitingAuthorization"
    });
    expect(waiting).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "actionContinueAuthorization" })
    ).not.toBeInTheDocument();

    fireEvent.click(waiting);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(beginAuthorization).not.toHaveBeenCalled();
    expect(cancelAuthorization).toHaveBeenCalledWith("gmail");
    await waitFor(() => expect(closeDialog).toHaveBeenCalledTimes(1));

    cancelAuthorization.mockClear();
    closeDialog.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(cancelAuthorization).toHaveBeenCalledWith("gmail");
    await waitFor(() => expect(closeDialog).toHaveBeenCalledTimes(1));

    viewState.dialog = {
      ...authorizationDialog,
      authorizing: false,
      pending: true
    };
    rerender(
      <ConnectorMarketRootProvider i18n={i18n} root={root}>
        <ConnectorMarketDialogs />
      </ConnectorMarketRootProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "actionAuthorize" }));
    expect(beginAuthorization).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "actionContinueAuthorization" })
    ).not.toBeInTheDocument();
  });
});
