import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import {
  AGENT_SESSION_TITLE_TOO_LONG_REASON,
  getAgentGUIErrorMessage
} from "./agentGuiController.errors";

describe("getAgentGUIErrorMessage", () => {
  afterEach(() => setAgentGuiI18nTestLocale("en"));

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
