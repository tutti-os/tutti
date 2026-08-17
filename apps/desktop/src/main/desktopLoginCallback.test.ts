import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDesktopAppOpenUrl } from "./desktopLoginCallback.ts";

describe("isDesktopAppOpenUrl", () => {
  it("accepts the exact app-open deep link for the active scheme", () => {
    assert.equal(isDesktopAppOpenUrl("tutti://open", "tutti"), true);
    assert.equal(isDesktopAppOpenUrl("tutti-dev://open/", "tutti-dev"), true);
  });

  it("rejects other schemes and paths", () => {
    assert.equal(isDesktopAppOpenUrl("other://open", "tutti"), false);
    assert.equal(isDesktopAppOpenUrl("tutti://open/other", "tutti"), false);
    assert.equal(isDesktopAppOpenUrl("not-a-url", "tutti"), false);
  });
});
