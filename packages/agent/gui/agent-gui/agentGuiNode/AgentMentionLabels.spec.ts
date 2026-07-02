import { describe, expect, it } from "vitest";
import { translateInUiLanguage } from "../../i18n/index";
import { setAgentGuiI18nTestLocale } from "../../i18n/testUtils";
import {
  agentMentionEmptyGroupLabel,
  agentMentionFilterLabel,
  agentMentionGroupLabel
} from "./AgentMentionLabels";

describe("AgentMentionLabels", () => {
  it("localizes mention filters and groups for English", async () => {
    setAgentGuiI18nTestLocale("en");

    expect(agentMentionFilterLabel("session")).toBe("Sessions");
    expect(agentMentionFilterLabel("agent")).toBe("Agents");
    expect(agentMentionFilterLabel("app")).toBe("Apps");
    expect(agentMentionGroupLabel("agents")).toBe("Agents");
    expect(agentMentionGroupLabel("apps")).toBe("Apps");
    expect(agentMentionGroupLabel("my_sessions")).toBe("My sessions");
    expect(agentMentionEmptyGroupLabel("my_sessions", "")).toBe(
      "No sessions yet"
    );
  });

  it("localizes mention filters and groups for Chinese", async () => {
    setAgentGuiI18nTestLocale("zh-CN");

    expect(agentMentionFilterLabel("app")).toBe("应用");
    expect(agentMentionFilterLabel("session")).toBe("会话");
    expect(agentMentionFilterLabel("issue")).toBe("任务");
    expect(agentMentionFilterLabel("agent")).toBe("智能体");
    expect(agentMentionGroupLabel("agents")).toBe("智能体");
    expect(agentMentionGroupLabel("apps")).toBe("应用");
    expect(agentMentionGroupLabel("issues")).toBe("任务");
    expect(agentMentionGroupLabel("my_sessions")).toBe("我的会话");
    expect(agentMentionEmptyGroupLabel("issues", "")).toBe("暂无任务");
    expect(agentMentionEmptyGroupLabel("agents", "")).toBe("暂无可用智能体");
    expect(agentMentionEmptyGroupLabel("files", "")).toBe(
      "Dock 栏暂无已打开文件，输入关键词可搜索工作区文件"
    );
    expect(agentMentionEmptyGroupLabel("files", "readme")).toBe(
      "没有匹配到文件"
    );
  });

  it("supports explicit language lookup in tests", () => {
    expect(
      translateInUiLanguage("en", "agentHost.agentGui.mentionFilterSession")
    ).toBe("Sessions");
  });
});
