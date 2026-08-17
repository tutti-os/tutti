import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(
  resolve(directory, "WorkspaceSettingsPanel.tsx"),
  "utf8"
);
const runtimeTabSource = readFileSync(
  resolve(directory, "WorkspaceAgentsSettingsTab.tsx"),
  "utf8"
);
const connectionSectionSource = readFileSync(
  resolve(directory, "WorkspaceConnectionSettingsSection.tsx"),
  "utf8"
);
const deletedConversationsSource = readFileSync(
  resolve(directory, "WorkspaceDeletedConversationsSection.tsx"),
  "utf8"
);

test("workspace settings gives Model an independent Plan-only section", () => {
  assert.match(panelSource, /id: "model" as const/);
  assert.match(
    panelSource,
    /function WorkspaceModelSettingsSection\(\) \{\s*return \(\s*<SettingsRows>\s*<WorkspaceModelPlansSection \/>\s*<\/SettingsRows>/
  );
  assert.doesNotMatch(panelSource, /WorkspaceAppsSettingsSection/);
  assert.doesNotMatch(panelSource, /WorkspaceAgentModelBindingSection/);
});

test("workspace settings places enabled signed-in Connectors between Agent Runtime and Custom Agents", () => {
  const general = panelSource.indexOf('value: "general" as const');
  const runtimes = panelSource.indexOf('value: "agents" as const');
  const connectors = panelSource.indexOf('value: "connectors" as const');
  const customAgents = panelSource.indexOf('value: "customAgents" as const');
  const automation = panelSource.indexOf('value: "automation" as const');

  assert.ok(general >= 0);
  assert.ok(runtimes > general);
  assert.ok(connectors > runtimes);
  assert.ok(customAgents > connectors);
  assert.ok(automation > customAgents);
  assert.match(
    panelSource,
    /agentTab === "customAgents"[\s\S]{0,220}<WorkspaceAgentsSection \/>/
  );
  assert.match(
    panelSource,
    /agentTab === "connectors"[\s\S]{0,260}<ConnectorMarketPanel/
  );
  assert.match(
    panelSource,
    /handleConnectorMarketError[\s\S]{0,180}notifications\.error\(\{ title: message \}\)/
  );
  assert.match(
    panelSource,
    /<ConnectorMarketPanel[\s\S]{0,180}onError=\{handleConnectorMarketError\}/
  );
  assert.match(
    panelSource,
    /connectorsVisible[\s\S]{0,220}value: "connectors" as const/
  );
  assert.match(
    panelSource,
    /!connectorsVisible[\s\S]{0,120}agentTab === "connectors"[\s\S]{0,120}selectAgentTab\("general"\)/
  );
  assert.match(
    panelSource,
    /accountState\.user !== null[\s\S]{0,120}LAB_CONNECTORS_FLAG/
  );
  assert.doesNotMatch(runtimeTabSource, /WorkspaceAgentsSection/);
});

test("workspace settings keeps account Connection without mobile remote access", () => {
  assert.match(panelSource, /id: "connection" as const/);
  assert.match(
    panelSource,
    /activeSection === "connection"[\s\S]{0,220}<WorkspaceConnectionSettingsSection/
  );
  assert.match(connectionSectionSource, /accountService\.refreshUserInfo\(\)/);
  assert.doesNotMatch(
    connectionSectionSource,
    /WorkspaceMobileRemoteSettingsSection/
  );
});

test("workspace settings gives deleted conversations a low-prominence top-level section", () => {
  const deletedConversations = panelSource.indexOf(
    'id: "deletedConversations" as const'
  );
  const about = panelSource.indexOf('id: "about" as const');

  assert.ok(deletedConversations >= 0);
  assert.ok(about > deletedConversations);
  assert.match(
    panelSource,
    /activeSection === "deletedConversations"[\s\S]{0,240}<WorkspaceDeletedConversationsSection/
  );
  assert.doesNotMatch(
    panelSource,
    /general\.deletedConversationRetentionLabel/
  );
});

test("deleted conversations uses one project filter and a virtualized scrolling list", () => {
  assert.match(deletedConversationsSource, /useVirtualizer\(/);
  assert.match(deletedConversationsSource, /controller\.loadMore\(\)/);
  assert.match(
    deletedConversationsSource,
    /workspace\.settings\.deletedConversations\.projectFilterLabel/
  );
  assert.doesNotMatch(deletedConversationsSource, /all conversations/i);
  assert.match(
    deletedConversationsSource,
    /operation === "deleting"[\s\S]{0,180}deletedConversations\.deleteAction/
  );
  assert.match(
    deletedConversationsSource,
    /function PermanentDeleteDialog[\s\S]{0,1600}deletedConversations\.permanentDelete/
  );
});
