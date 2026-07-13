import { describe, expect, it } from "vitest";
import type { AgentGUIProps } from "./AgentGUI";

type LegacyDirectoryProp = Extract<
  keyof AgentGUIProps,
  "agents" | "agentsLoading"
>;
type InternalTargetCapability = Extract<
  keyof AgentGUIProps["hostCapabilities"],
  | "agentTargets"
  | "agentTargetsLoading"
  | "providerRailAllPresentation"
  | "providerRailMode"
>;
type InternalRailSlot = Extract<
  keyof AgentGUIProps["renderSlots"],
  "providerRailEmpty"
>;

const legacyDirectoryPropsAreNotPublic: Record<LegacyDirectoryProp, never> = {};
const internalTargetCapabilitiesAreNotPublic: Record<
  InternalTargetCapability,
  never
> = {};
const internalRailSlotsAreNotPublic: Record<InternalRailSlot, never> = {};

describe("AgentGUI public contract", () => {
  it("exposes one directory snapshot without writable normalized target seams", () => {
    expect(legacyDirectoryPropsAreNotPublic).toEqual({});
    expect(internalTargetCapabilitiesAreNotPublic).toEqual({});
    expect(internalRailSlotsAreNotPublic).toEqual({});
  });
});
