import { describe, expect, it } from "vitest";
import { nativeTheme, resolveNativeTheme } from "./tokens";

describe("Native renderer themes", () => {
  it("maps each mode to a semantic Native theme", () => {
    const light = resolveNativeTheme("light");
    const dark = resolveNativeTheme("dark");

    expect(light.mode).toBe("light");
    expect(dark.mode).toBe("dark");
    expect(light.color.background).not.toBe(dark.color.background);
    expect(light.color.text).not.toBe(dark.color.text);
    expect(light.control).toBe(dark.control);
  });

  it("keeps the legacy theme as the dark renderer theme", () => {
    expect(nativeTheme).toEqual(resolveNativeTheme("dark"));
  });
});
