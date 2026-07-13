import { describe, expect, it } from "vitest";
import type { AgentGUINodeProps } from "./AgentGUINode.types";

const publicPropKeys = [
  "identity",
  "workspace",
  "frame",
  "state",
  "runtimeRequests",
  "hostCapabilities",
  "hostActions",
  "renderSlots"
] as const satisfies readonly (keyof AgentGUINodeProps)[];

type UnlistedPublicProp = Exclude<
  keyof AgentGUINodeProps,
  (typeof publicPropKeys)[number]
>;
const allPublicPropsAreListed: Record<UnlistedPublicProp, true> = {};

describe("AgentGUINode public contract", () => {
  it("exposes only semantic responsibility objects at the top level", () => {
    expect(allPublicPropsAreListed).toEqual({});
    expect(publicPropKeys).toEqual([
      "identity",
      "workspace",
      "frame",
      "state",
      "runtimeRequests",
      "hostCapabilities",
      "hostActions",
      "renderSlots"
    ]);
  });
});
