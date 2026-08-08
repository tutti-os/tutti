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
});
