import { describe, expect, it } from "vitest";
import {
  buildTuttiBrowserUseSubmitPrompt,
  parseTuttiBrowserUseInvocation
} from "./agentBrowserUseSubmit";

describe("agentBrowserUseSubmit", () => {
  it("parses slash and dollar browser invocations", () => {
    expect(parseTuttiBrowserUseInvocation("/browser")).toEqual({
      commandName: "browser",
      args: ""
    });
    expect(parseTuttiBrowserUseInvocation("/browser open google.com")).toEqual({
      commandName: "browser",
      args: "open google.com"
    });
    expect(
      parseTuttiBrowserUseInvocation("$browser 帮我访问下 google.com")
    ).toEqual({
      commandName: "browser",
      args: "帮我访问下 google.com"
    });
    expect(parseTuttiBrowserUseInvocation("/浏览器 打开百度")).toEqual({
      commandName: "浏览器",
      args: "打开百度"
    });
  });

  it("builds a tutti browser-use submit prompt", () => {
    expect(buildTuttiBrowserUseSubmitPrompt("")).toContain("browser-use");
    expect(buildTuttiBrowserUseSubmitPrompt("visit google.com")).toContain(
      "visit google.com"
    );
  });
});
