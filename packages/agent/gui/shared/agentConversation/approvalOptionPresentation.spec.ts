import { beforeEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../i18n/testUtils";
import {
  approvalOptionDisplayLabel,
  approvalOptionVisualPresentation
} from "./approvalOptionPresentation";

describe("approvalOptionDisplayLabel", () => {
  beforeEach(() => {
    setAgentGuiI18nTestLocale("zh-CN");
  });

  it("localizes known plan-mode approval option ids", () => {
    expect(
      approvalOptionDisplayLabel({
        id: "auto",
        kind: "allow_always",
        label: 'Yes, and use "auto" mode'
      })
    ).toBe("允许，并使用自动模式");
    expect(
      approvalOptionDisplayLabel({
        id: "default",
        kind: "allow_once",
        label: "Yes, and manually approve edits"
      })
    ).toBe("允许，并手动确认编辑");
  });

  it("localizes Codex ACP permission option labels", () => {
    expect(
      approvalOptionDisplayLabel({
        id: "approved",
        kind: "allow_once",
        label: "Allow"
      })
    ).toBe("允许执行");
    expect(
      approvalOptionDisplayLabel({
        id: "approved-for-session",
        kind: "allow_always",
        label: "Allow for this session"
      })
    ).toBe("本次会话允许");
    expect(
      approvalOptionDisplayLabel({
        id: "approved-always",
        kind: "allow_always",
        label: "Allow and don't ask again"
      })
    ).toBe("允许，并且不再询问");
    expect(
      approvalOptionDisplayLabel({
        id: "cancel",
        kind: "reject_once",
        label: "Cancel"
      })
    ).toBe("取消");
    expect(
      approvalOptionDisplayLabel(
        {
          id: "cancel",
          kind: "reject_once",
          label: "Cancel"
        },
        { feedback: true }
      )
    ).toBe("拒绝，然后发送新的指令");
  });

  it("falls back to provider labels for ambiguous option ids", () => {
    expect(
      approvalOptionDisplayLabel({
        id: "auto",
        kind: "allow_always",
        label: "Auto approve this provider-specific scope"
      })
    ).toBe("Auto approve this provider-specific scope");
    expect(
      approvalOptionDisplayLabel({
        id: "default",
        kind: "allow_once",
        label: "Use provider default"
      })
    ).toBe("Use provider default");
  });

  it("localizes provider labels with known allow scopes", () => {
    expect(
      approvalOptionDisplayLabel({
        id: "approved-execpolicy-amendment",
        kind: "allow_always",
        label: "Yes, and don't ask again for commands that start with `curl`"
      })
    ).toBe("允许，并且不再询问以 `curl` 开头的命令");
    expect(
      approvalOptionDisplayLabel({
        id: "allow_always",
        kind: "allow_always",
        label: "Always Allow Bash(chmod +x ./bootstrap.sh)"
      })
    ).toBe("始终允许 Bash(chmod +x ./bootstrap.sh)");
  });

  it("splits command-prefix approval options for visual display", () => {
    expect(
      approvalOptionVisualPresentation({
        id: "approved-execpolicy-amendment",
        kind: "allow_always",
        label:
          "Yes, and don't ask again for commands that start with `pnpm --dir apps/tsh-desktop view`"
      })
    ).toEqual({
      label: "允许，并且不再询问以下列内容开头的命令",
      commandPrefix: "pnpm --dir apps/tsh-desktop view"
    });
  });
});
