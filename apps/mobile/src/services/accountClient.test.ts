jest.mock("../native/mobileNative", () => ({
  __esModule: true,
  mobileSecurity: {
    installSessionCookie: jest.fn(),
    startBrowserLogin: jest.fn()
  }
}));

import { mobileSecurity } from "../native/mobileNative";
import { accountAppID } from "../config";
import { signInWithGitHub } from "./accountClient";

const mockStartBrowserLogin = jest.mocked(mobileSecurity.startBrowserLogin);

function accountResponse(data: unknown): Response {
  return {
    json: async () => ({ code: 0, data }),
    ok: true,
    status: 200
  } as Response;
}

describe("signInWithGitHub", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("redeems the browser transfer code and loads the canonical account", async () => {
    mockStartBrowserLogin.mockResolvedValue({
      attemptId: "attempt-1",
      bridgeToken: "bridge-token-1",
      deviceId: "mobile-device-1",
      transferCode: "transfer-code-1"
    });
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(accountResponse({ session_id: "session-1" }))
      .mockResolvedValueOnce(
        accountResponse({
          email: "alice@example.com",
          name: "Alice",
          user_id: "user-1"
        })
      );
    globalThis.fetch = fetchMock;

    await expect(signInWithGitHub()).resolves.toEqual({
      email: "alice@example.com",
      name: "Alice",
      sessionId: "session-1",
      userId: "user-1"
    });

    expect(mockStartBrowserLogin).toHaveBeenCalledWith(
      accountAppID,
      "https://tutti.sh/auth/login",
      "tutti://auth/login"
    );
    expect(mobileSecurity.installSessionCookie).toHaveBeenCalledWith(
      "https://tutti.sh/api/account",
      "session-1"
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://tutti.sh/api/account/auth/v1/redeem_desktop_transfer_code",
      expect.objectContaining({
        body: JSON.stringify({
          app_id: accountAppID,
          attempt_id: "attempt-1",
          bridge_token: "bridge-token-1",
          device_id: "mobile-device-1",
          transfer_code: "transfer-code-1"
        }),
        method: "POST"
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://tutti.sh/api/account/user/v1/user_info",
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: "session_id=session-1"
        }),
        method: "POST"
      })
    );
  });
});
