import { normalizeMobileLocaleIdentifier } from "./i18n";

describe("mobile locale", () => {
  test.each([
    ["zh-CN", "zh-CN"],
    ["zh_Hans_CN", "zh-CN"],
    ["en-US", "en"],
    [undefined, "en"]
  ])("normalizes %p to %s", (identifier, expected) => {
    expect(normalizeMobileLocaleIdentifier(identifier)).toBe(expected);
  });
});
