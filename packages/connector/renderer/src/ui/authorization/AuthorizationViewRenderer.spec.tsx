import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthorizationViewEnvelopeV1 } from "@tutti-os/connector-contracts/authorization/v1";

import { DefaultAuthorizationViewRenderer } from "./AuthorizationViewRenderer.tsx";

afterEach(cleanup);

const labels = {
  activate: "Continue",
  cancel: "Cancel",
  copyDeviceCode: "Copy device code",
  deviceCodeCopied: "Device code copied",
  qrCodeAlt: "Authorization QR code",
  refresh: "Refresh",
  retry: "Retry",
  submit: "Authorize",
  unsupportedField: "Unsupported"
};

const secretFormView: AuthorizationViewEnvelopeV1 = {
  protocol: "tutti.connector.authorization.view.v1",
  viewId: "form-1",
  view: {
    type: "form",
    fields: [
      {
        type: "secret",
        name: "secret",
        label: "Access token",
        placeholder: "Paste token",
        required: true
      }
    ]
  }
};

describe("DefaultAuthorizationViewRenderer", () => {
  it("keeps the typed secret after authorize so a failed attempt can retry", () => {
    const onEvent = vi.fn();
    render(
      <DefaultAuthorizationViewRenderer
        busy={false}
        labels={labels}
        view={secretFormView}
        onEvent={onEvent}
      />
    );

    const input = screen.getByLabelText(/Access token/);
    fireEvent.change(input, { target: { value: "pat_keep_me" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize" }));

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({
      viewId: "form-1",
      event: { type: "submit", values: { secret: "pat_keep_me" } }
    });
    expect(screen.getByLabelText(/Access token/)).toHaveValue("pat_keep_me");
  });
});
