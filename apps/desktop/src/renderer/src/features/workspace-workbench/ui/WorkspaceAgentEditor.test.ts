import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderCapabilityOption } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAgentDraft } from "../services/workspaceSettingsTypes.ts";
import {
  createWorkspaceAgentCapabilitySelectionPatch,
  workspaceAgentCapabilityIsSelected,
  workspaceAgentSelectableCapabilityOptions
} from "./workspaceAgentCapabilities.ts";

const catalog: AgentProviderCapabilityOption[] = [
  {
    id: "skill:reviewer",
    invocation: "promptItem",
    kind: "skill",
    label: "Reviewer",
    name: "reviewer",
    status: "available"
  },
  {
    id: "connector:github",
    invocation: "promptItem",
    kind: "connector",
    label: "GitHub",
    name: "github",
    status: "available"
  },
  {
    id: "mcpServer:files",
    invocation: "none",
    kind: "mcpServer",
    label: "files",
    name: "files",
    serverName: "files",
    status: "available"
  },
  {
    id: "mcpTool:files/read",
    invocation: "none",
    kind: "mcpTool",
    label: "read",
    name: "read",
    serverName: "files",
    status: "available"
  },
  {
    id: "connector:legacy",
    invocation: "none",
    kind: "connector",
    label: "Legacy",
    name: "legacy",
    status: "unsupported"
  }
];

test("capability selection materializes automatic defaults before removing one", () => {
  const draft = createDraft();
  const patch = createWorkspaceAgentCapabilitySelectionPatch(
    draft,
    catalog,
    "connector:github",
    false
  );

  assert.equal(patch.capabilitiesExplicit, true);
  assert.equal(patch.skills, "reviewer");
  assert.equal(patch.tools, "mcpServer:files");
  assert.equal(
    workspaceAgentCapabilityIsSelected(draft, catalog.at(-1)!),
    false
  );
});

test("explicit capability selection can represent none", () => {
  const draft = createDraft({
    capabilitiesExplicit: true,
    skills: "reviewer",
    tools: "connector:github"
  });
  const withoutSkill = createWorkspaceAgentCapabilitySelectionPatch(
    draft,
    catalog,
    "skill:reviewer",
    false
  );
  const withoutConnector = createWorkspaceAgentCapabilitySelectionPatch(
    { ...draft, ...withoutSkill },
    catalog,
    "connector:github",
    false
  );

  assert.equal(withoutConnector.skills, "");
  assert.equal(withoutConnector.tools, "");
  assert.equal(
    workspaceAgentCapabilityIsSelected(
      { ...draft, ...withoutConnector },
      catalog[0]!
    ),
    false
  );
});

test("capability selection collapses MCP tools under their server", () => {
  assert.deepEqual(
    workspaceAgentSelectableCapabilityOptions(catalog).map(
      (option) => option.id
    ),
    [
      "skill:reviewer",
      "connector:github",
      "mcpServer:files",
      "connector:legacy"
    ]
  );
});

function createDraft(
  overrides: Partial<WorkspaceAgentDraft> = {}
): WorkspaceAgentDraft {
  return {
    agentId: null,
    callConditions: "",
    capabilitiesExplicit: false,
    defaultModel: "",
    enabled: true,
    generatedAutomationRules: [],
    generationRequirements: "",
    harnessAgentTargetId: "local:codex",
    instructions: "",
    modelFallbacks: [],
    modelPlanId: "",
    name: "Reviewer",
    permissions: "",
    purpose: "",
    skills: "",
    tools: "",
    ...overrides
  };
}
