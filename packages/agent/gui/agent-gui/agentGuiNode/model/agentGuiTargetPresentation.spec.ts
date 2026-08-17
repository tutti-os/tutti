import { describe, expect, it } from "vitest";
import type { AgentGUIAgentTarget } from "../../../types";
import {
  agentTargetPresentationKey,
  mergeAgentTargetsForMentionPresentations,
  projectAgentTargetPresentations,
  projectMentionAgentTargetPresentations,
  resolveMentionAgentTargetsForPresentations
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
        ownerSeparator: "'s ",
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

  it("uses the localized owner-qualified label for shared Agent mentions", () => {
    expect(
      projectAgentTargetPresentations({
        agentTargets: [
          {
            ...TARGET,
            label: "Codex",
            ownerLabel: "Lin",
            ownership: "shared"
          }
        ],
        ownerSeparator: " 的 ",
        workspaceId: "workspace-1"
      })
    ).toMatchObject([{ name: "Lin 的 Codex" }]);
  });

  it("invalidates presentation memoization when shared ownership changes", () => {
    expect(agentTargetPresentationKey([TARGET])).not.toBe(
      agentTargetPresentationKey([
        {
          ...TARGET,
          ownerLabel: "Lin",
          ownership: "shared"
        }
      ])
    );
  });

  it("merges handoff-only shared targets into mention presentation lookup", () => {
    const local: AgentGUIAgentTarget = {
      ...TARGET,
      agentTargetId: "local:codex",
      label: "Codex",
      provider: "codex",
      targetId: "local:codex"
    };
    const shared: AgentGUIAgentTarget = {
      ...TARGET,
      agentTargetId: "shared-agent:jun-codex",
      iconUrl: "data:image/png;base64,shared-codex",
      label: "Codex",
      ownerLabel: "Jun Sun",
      ownership: "shared",
      provider: "codex",
      targetId: "shared-agent:jun-codex"
    };

    expect(
      mergeAgentTargetsForMentionPresentations([local], [local, shared])
    ).toEqual([local, shared]);
    expect(
      projectAgentTargetPresentations({
        agentTargets: mergeAgentTargetsForMentionPresentations(
          [local],
          [shared]
        ),
        ownerSeparator: " 的 ",
        workspaceId: "workspace-1"
      })
    ).toMatchObject([
      { agentTargetId: "local:codex", iconUrl: local.iconUrl },
      {
        agentTargetId: "shared-agent:jun-codex",
        iconUrl: "data:image/png;base64,shared-codex",
        name: "Jun Sun 的 Codex"
      }
    ]);
  });

  it("uses a complete identity catalog instead of action projections", () => {
    const local: AgentGUIAgentTarget = {
      ...TARGET,
      agentTargetId: "local:codex",
      label: "Codex",
      provider: "codex",
      targetId: "local:codex"
    };
    const offlineShared: AgentGUIAgentTarget = {
      ...TARGET,
      agentTargetId: "shared-agent:rv4no-codex",
      disabled: true,
      iconUrl: "data:image/png;base64,shared-codex",
      label: "Codex",
      ownerLabel: "rv4no",
      ownership: "shared",
      provider: "codex",
      targetId: "shared-agent:rv4no-codex"
    };

    expect(
      resolveMentionAgentTargetsForPresentations({
        handoffTargets: [local],
        mentionTargets: [offlineShared],
        railTargets: [local]
      })
    ).toEqual([offlineShared]);
    expect(
      projectMentionAgentTargetPresentations({
        handoffTargets: [local],
        mentionTargets: [offlineShared],
        ownerSeparator: "'s ",
        railTargets: [local],
        workspaceId: "workspace-1"
      })
    ).toEqual([
      {
        agentTargetId: "shared-agent:rv4no-codex",
        iconUrl: "data:image/png;base64,shared-codex",
        maskIconUrl: TARGET.maskIconUrl,
        name: "rv4no's Codex",
        provider: "codex",
        workspaceId: "workspace-1"
      }
    ]);
  });
});
