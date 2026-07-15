import { describe, expect, it } from "vitest";
import {
  agentCapabilityUseDisplayPrompt,
  buildAgentCapabilityUseSubmitPrompt,
  parseAgentCapabilityUseInvocation
} from "./agentCapabilityUseSubmit";

describe("agentCapabilityUseSubmit", () => {
  it.each([
    ["browserUse", "/browser", "browser", ""],
    ["browserUse", "/browser open google.com", "browser", "open google.com"],
    ["browserUse", "$浏览器 打开百度", "浏览器", "打开百度"],
    ["computerUse", "/computer", "computer", ""],
    ["computerUse", "$computer open Settings", "computer", "open Settings"],
    ["computerUse", "/电脑 点击确认", "电脑", "点击确认"]
  ] as const)(
    "parses the %s invocation %s",
    (capability, draft, commandName, args) => {
      expect(parseAgentCapabilityUseInvocation(draft, capability)).toEqual({
        commandName,
        args
      });
    }
  );

  it("does not match another capability's invocation", () => {
    expect(
      parseAgentCapabilityUseInvocation("/computer test", "browserUse")
    ).toBeNull();
    expect(
      parseAgentCapabilityUseInvocation("/browser test", "computerUse")
    ).toBeNull();
  });

  it.each([
    ["browserUse", "visit google.com", "browser-use"],
    ["computerUse", "click Confirm", "computer-use"]
  ] as const)(
    "builds the %s handoff prompt",
    (capability, args, expectedSkill) => {
      const prompt = buildAgentCapabilityUseSubmitPrompt(capability, args);
      expect(prompt).toContain(expectedSkill);
      expect(prompt).toContain(args);
    }
  );

  it("normalizes capability display prompts", () => {
    expect(agentCapabilityUseDisplayPrompt("browserUse", " open docs ")).toBe(
      "/browser open docs"
    );
    expect(agentCapabilityUseDisplayPrompt("computerUse", "点击确认")).toBe(
      "/computer 点击确认"
    );
  });
});
