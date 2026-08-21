import { describe, expect, it } from "vitest";
import { resolveAgentGuiI18nRuntime } from "./runtime.ts";

describe("AgentGUI bundled i18n runtime", () => {
  it.each([
    ["en", "No project"],
    ["zh-CN", "不使用项目"]
  ] as const)(
    "includes workspace project defaults for %s",
    (locale, expected) => {
      const { runtime } = resolveAgentGuiI18nRuntime({ locale });

      expect(runtime.t("workspaceUserProject.projectSelect.noProject")).toBe(
        expected
      );
    }
  );

  it.each([
    ["en", "Account quota is currently unavailable"],
    ["zh-CN", "账户额度暂不可用"]
  ] as const)(
    "uses precise unavailable account quota copy for %s",
    (locale, expected) => {
      const { runtime } = resolveAgentGuiI18nRuntime({ locale });

      expect(runtime.t("agentHost.agentGui.slashStatusLimitsUnavailable")).toBe(
        expected
      );
    }
  );
});
