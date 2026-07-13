import { describe, expect, it } from "vitest";
import type { AgentGUINodeViewModel } from "./agentGuiNodeTypes";

const publicViewModelKeys = [
  "shell",
  "rail",
  "detail",
  "composer",
  "interaction",
  "readiness",
  "operations"
] as const satisfies readonly (keyof AgentGUINodeViewModel)[];

type UnlistedViewModelKey = Exclude<
  keyof AgentGUINodeViewModel,
  (typeof publicViewModelKeys)[number]
>;
const allViewModelKeysAreListed: Record<UnlistedViewModelKey, true> = {};

describe("AgentGUINodeViewModel public contract", () => {
  it("exposes only vertical responsibility models at the top level", () => {
    expect(allViewModelKeysAreListed).toEqual({});
    expect(publicViewModelKeys).toEqual([
      "shell",
      "rail",
      "detail",
      "composer",
      "interaction",
      "readiness",
      "operations"
    ]);
  });
});
