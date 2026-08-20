import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import {
  AGENT_PROCESS_CLEANUP_PENDING_REASON,
  AGENT_SESSION_TITLE_TOO_LONG_REASON,
  getAgentGUIErrorMessage
} from "./agentGuiController.errors";

describe("getAgentGUIErrorMessage", () => {
  afterEach(() => setAgentGuiI18nTestLocale("en"));

  it("localizes unavailable configuration dependencies", () => {
    setAgentGuiI18nTestLocale("zh-CN");

    expect(
      getAgentGUIErrorMessage({
        reason: "agent.config_dependency_unavailable",
        params: {
          provider: "codex",
          configKey: "model_instructions_file",
          dependencyPath: "instructions.md",
          failureKind: "missing"
        }
      })
    ).toBe("Codex 的配置引用了当前不可用的文件，请检查本机配置后重试");
  });

  it("localizes pending process cleanup without exposing runtime copy", () => {
    setAgentGuiI18nTestLocale("zh-CN");

    expect(
      getAgentGUIErrorMessage({
        debugMessage: "injected transport close failure",
        reason: AGENT_PROCESS_CLEANUP_PENDING_REASON
      })
    ).toBe(
      "上一个 Agent 进程仍在退出。为避免重复启动，本次操作已停止，请稍后重试"
    );
  });

  it("localizes the structured session title limit error", () => {
    setAgentGuiI18nTestLocale("zh-CN");

    expect(
      getAgentGUIErrorMessage({
        debugMessage:
          "invalid agent session request: title must be at most 120 characters",
        params: { maxCharacters: 120 },
        reason: AGENT_SESSION_TITLE_TOO_LONG_REASON
      })
    ).toBe("会话标题不能超过 120 个字符。");
  });

  it("uses a localized fallback when the limit param is absent", () => {
    setAgentGuiI18nTestLocale("zh-CN");

    expect(
      getAgentGUIErrorMessage({
        debugMessage:
          "invalid agent session request: title must be at most 120 characters",
        reason: AGENT_SESSION_TITLE_TOO_LONG_REASON
      })
    ).toBe("会话标题过长。");
  });
});
