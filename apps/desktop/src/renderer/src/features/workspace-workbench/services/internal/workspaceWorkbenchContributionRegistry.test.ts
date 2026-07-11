import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  DesktopWorkbenchContributionContext,
  DesktopWorkbenchContributionFactory
} from "./workspaceWorkbenchContributionFactory";
import { createWorkspaceWorkbenchContributionRegistryResult } from "./workspaceWorkbenchContributionRegistry.ts";

test("workbench contribution registry sorts factories and skips unavailable entries", () => {
  const registry = createWorkspaceWorkbenchContributionRegistryResult({
    context: {} as DesktopWorkbenchContributionContext,
    factories: [
      createFactory({ id: "terminal", order: 40 }),
      createFactory({ id: "files", order: 10 }),
      createFactory({ id: "browser", order: 20, unavailable: true })
    ]
  });

  assert.deepEqual(
    registry.contributions.map((contribution) => contribution.id),
    ["files", "terminal"]
  );
});

test("default desktop workbench contribution factories keep their current ids and resolved order", () => {
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
  const defaultFactorySource = readFileSync(
    new URL(
      "./contributions/defaultWorkspaceWorkbenchContributionFactories.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.deepEqual(
    Array.from(
      defaultFactorySource.matchAll(
        /^\s{4}(\w+WorkbenchContributionFactory),?$/gm
      ),
      (match) => match[1]
    ),
    expectedFactories.map(({ exportName }) => exportName)
  );
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

  const registry = createWorkspaceWorkbenchContributionRegistryResult({
    context: {} as DesktopWorkbenchContributionContext,
    factories: expectedFactories.map(({ id, order }) =>
      createFactory({ id, order })
    )
  });

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
  id: string;
  order: number;
  unavailable?: boolean;
}): DesktopWorkbenchContributionFactory {
  return {
    id: input.id,
    order: input.order,
    create() {
      if (input.unavailable) {
        return null;
      }

      return {
        id: input.id
      };
    }
  };
}
