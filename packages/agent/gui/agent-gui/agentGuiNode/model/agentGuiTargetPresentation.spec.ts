import { describe, expect, it } from "vitest";
import type { AgentGUIAgentTarget } from "../../../types";
import {
  agentTargetPresentationKey,
  projectAgentTargetPresentations
} from "./agentGuiTargetPresentation";

const TARGET: AgentGUIAgentTarget = {
  agentTargetId: "extension:kilo",
  iconUrl: "data:image/svg+xml;base64,kilo-colored",
  label: "Kilo CLI",
  maskIconUrl: "data:image/svg+xml;base64,kilo-mask",
  provider: "acp:kilo",
  ref: {
    kind: "agent_extension",
    provider: "acp:kilo"
  },
  targetId: "extension:kilo"
};

describe("Agent GUI target presentation projection", () => {
  it("passes the conversation mask from the rail target into presentation context", () => {
    expect(
      projectAgentTargetPresentations({
        agentTargets: [TARGET],
        workspaceId: "workspace-1"
      })
    ).toEqual([
      {
        agentTargetId: "extension:kilo",
        iconUrl: "data:image/svg+xml;base64,kilo-colored",
        maskIconUrl: "data:image/svg+xml;base64,kilo-mask",
        name: "Kilo CLI",
        provider: "acp:kilo",
        workspaceId: "workspace-1"
      }
    ]);
  });

  it("invalidates presentation memoization when only the mask changes", () => {
    expect(agentTargetPresentationKey([TARGET])).not.toBe(
      agentTargetPresentationKey([
        {
          ...TARGET,
          maskIconUrl: "data:image/svg+xml;base64,kilo-mask-next"
        }
      ])
    );
  });
});
