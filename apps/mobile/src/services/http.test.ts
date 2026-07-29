import { accountCookie } from "./http";

describe("accountCookie", () => {
  test("normalizes a valid account session", () => {
    expect(accountCookie(" session-1 ")).toBe("session_id=session-1");
  });

  test.each(["", "session;admin=true", "session\rvalue", "session\nvalue"])(
    "rejects an unsafe account session value",
    (sessionId) => {
      expect(() => accountCookie(sessionId)).toThrow(
        "account session is missing"
      );
    }
  );
});
