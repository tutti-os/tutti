import { describe, expect, it } from "vitest";
import { buildAssetUrl } from "./assetUrl";

describe("buildAssetUrl", () => {
  it("preserves delivery authorization while appending a frozen variant", () => {
    const result = buildAssetUrl(
      "https://assets.tutti.sh/v1/assets/u/room_snapshot/a.png?expires=10&keyId=k&policy=private&signature=s",
      { kind: "image", width: 1280, format: "webp" }
    );

    expect(Object.fromEntries(new URL(result).searchParams)).toEqual({
      expires: "10",
      keyId: "k",
      policy: "private",
      signature: "s",
      width: "1280",
      fit: "scale-down",
      format: "webp"
    });
  });
});
