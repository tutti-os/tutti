import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveWorkbenchCapabilityRegistry } from "./workbenchCapabilityRegistry.ts";
import type {
  WorkbenchCapabilityFactoryDescriptor,
  WorkbenchProductProfile
} from "./workbenchProductProfile.ts";

test("workbench contribution registry sorts factories and skips unavailable entries", () => {
  const registry = resolveWorkbenchCapabilityRegistry(
    createProfile([
      createFactory({ id: "terminal", order: 40 }),
      createFactory({ id: "files", order: 10 }),
      createFactory({ id: "browser", order: 20, unavailable: true })
    ])
  );

  assert.deepEqual(
    registry.contributions.map((contribution) => contribution.id),
    ["files", "terminal"]
  );
});

test("Tutti workbench product profile keeps its product, scope, factory ids, and resolved order", () => {
  const expectedFactories = [
    {
      exportName: "filesWorkbenchContributionFactory",
      id: "workspace-files",
      order: 10
    },
    {
      exportName: "filePreviewWorkbenchContributionFactory",
      id: "workspace-file-preview",
      order: 15
    },
    {
      exportName: "appCenterWorkbenchContributionFactory",
      id: "workspace-app-center",
      order: 18
    },
    {
      exportName: "browserWorkbenchContributionFactory",
      id: "workspace-browser",
      order: 20
    },
    {
      exportName: "agentGuiWorkbenchContributionFactory",
      id: "workspace-agent-gui",
      order: 25
    },
    {
      exportName: "issueManagerWorkbenchContributionFactory",
      id: "workspace-issue-manager",
      order: 0
    },
    {
      exportName: "terminalWorkbenchContributionFactory",
      id: "workspace-terminal",
      order: 40
    }
  ] as const;
  const profileSource = readFileSync(
    new URL("./tuttiWorkbenchProductProfile.ts", import.meta.url),
    "utf8"
  );
  assert.deepEqual(
    Array.from(
      profileSource.matchAll(
        /bindDesktopWorkbenchContributionFactory\(\s+(\w+WorkbenchContributionFactory),/g
      ),
      (match) => match[1]
    ),
    expectedFactories.map(({ exportName }) => exportName)
  );
  assert.match(profileSource, /productId: "tutti"/);
  assert.match(profileSource, /scopeKind: "workspace"/);
  for (const expected of expectedFactories) {
    const factoryFileName = expected.exportName.replace(
      /WorkbenchContributionFactory$/,
      "WorkbenchContributionFactory.ts"
    );
    const source = readFileSync(
      new URL(`./contributions/${factoryFileName}`, import.meta.url),
      "utf8"
    );
    assert.match(source, new RegExp(`id: "${expected.id}"`));
    assert.match(source, new RegExp(`order: ${expected.order}`));
  }

  const registry = resolveWorkbenchCapabilityRegistry(
    createProfile(
      expectedFactories.map(({ id, order }) => createFactory({ id, order }))
    )
  );

  assert.deepEqual(
    registry.contributions.map(({ id }) => id),
    [
      "workspace-issue-manager",
      "workspace-files",
      "workspace-file-preview",
      "workspace-app-center",
      "workspace-browser",
      "workspace-agent-gui",
      "workspace-terminal"
    ]
  );
});

test("workbench capability registry rejects duplicate factory and contribution ownership", () => {
  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({ id: "duplicate", order: 10 }),
          createFactory({ id: "duplicate", order: 20 })
        ])
      ),
    /capability factory id "duplicate" has multiple owners/
  );

  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({
            contributionId: "duplicate",
            id: "first",
            order: 10
          }),
          createFactory({
            contributionId: "duplicate",
            id: "second",
            order: 20
          })
        ])
      ),
    /contribution id "duplicate"/
  );
});

test("workbench capability registry rejects duplicate node and dock ownership", () => {
  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({ id: "first", nodeTypeId: "shared-node", order: 10 }),
          createFactory({ id: "second", nodeTypeId: "shared-node", order: 20 })
        ])
      ),
    /node type id "shared-node"/
  );

  assert.throws(
    () =>
      resolveWorkbenchCapabilityRegistry(
        createProfile([
          createFactory({ dockEntryId: "shared-dock", id: "first", order: 10 }),
          createFactory({ dockEntryId: "shared-dock", id: "second", order: 20 })
        ])
      ),
    /dock entry id "shared-dock"/
  );
});

test("default desktop contribution adapters keep current contribution, node, and fixed dock contracts", () => {
  const contracts = [
    {
      file: "../../../workspace-app-center/services/internal/workspaceAppCenterContribution.tsx",
      patterns: [
        /id: "workspace-app-center"/,
        /id: workspaceAppCenterNodeID,\s+label: title,\s+launchBehavior: "enabled"/,
        /order: workspaceAppCenterDockOrder/,
        /typeId: workspaceAppCenterNodeID/
      ]
    },
    {
      file: "./workspaceBrowserContribution.ts",
      patterns: [
        /contributionId: "workspace-browser"/,
        /id: workspaceBrowserNodeID,\s+order: 20/,
        /typeId: workspaceBrowserNodeID/
      ]
    },
    {
      file: "./workspaceIssueManagerContribution.ts",
      patterns: [
        /contributionId: "workspace-issue-manager"/,
        /id: defaultIssueManagerWorkbenchTypeId,\s+order: 0/,
        /typeId: defaultIssueManagerWorkbenchTypeId/
      ]
    },
    {
      file: "./workspaceTerminalContribution.ts",
      patterns: [
        /contributionId: "workspace-terminal"/,
        /id: defaultWorkspaceTerminalWorkbenchTypeId,\s+order: 40/,
        /typeId: defaultWorkspaceTerminalWorkbenchTypeId/
      ]
    },
    {
      file: "./workspaceAgentGuiContribution.ts",
      patterns: [
        /createAgentGuiWorkbenchContribution\(\{/,
        /workspaceId: input\.workspaceId/
      ]
    }
  ];

  for (const contract of contracts) {
    const source = readFileSync(
      new URL(contract.file, import.meta.url),
      "utf8"
    );
    for (const pattern of contract.patterns) {
      assert.match(source, pattern, `${contract.file} must match ${pattern}`);
    }
  }

  const agentGuiPackageSource = readFileSync(
    new URL(
      "../../../../../../../../../packages/agent/gui/workbench/contribution.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    agentGuiPackageSource,
    /id: input\.id \?\? "workspace-agent-gui"/
  );
  assert.match(
    agentGuiPackageSource,
    /id: agentGuiWorkbenchUnifiedDockEntryId\(\)/
  );
  assert.match(agentGuiPackageSource, /order: input\.order/);
  assert.match(agentGuiPackageSource, /typeId: agentGuiWorkbenchTypeId/);
});

function createFactory(input: {
  contributionId?: string;
  dockEntryId?: string;
  id: string;
  nodeTypeId?: string;
  order: number;
  unavailable?: boolean;
}): WorkbenchCapabilityFactoryDescriptor {
  return {
    id: input.id,
    order: input.order,
    create() {
      if (input.unavailable) {
        return null;
      }

      return {
        ...(input.dockEntryId
          ? { dockEntries: [{ id: input.dockEntryId } as never] }
          : {}),
        id: input.contributionId ?? input.id,
        ...(input.nodeTypeId
          ? { nodes: [{ typeId: input.nodeTypeId } as never] }
          : {})
      };
    }
  };
}

function createProfile(
  capabilityFactories: readonly WorkbenchCapabilityFactoryDescriptor[]
): WorkbenchProductProfile {
  return {
    capabilityFactories,
    productId: "test",
    scopeKind: "workspace"
  };
}
