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

test("workspace settings gives Model an independent Plan-only section", () => {
  assert.match(panelSource, /id: "model" as const/);
  assert.match(
    panelSource,
    /function WorkspaceModelSettingsSection\(\) \{\s*return \(\s*<SettingsRows>\s*<WorkspaceModelPlansSection \/>\s*<\/SettingsRows>/
  );
  assert.doesNotMatch(panelSource, /WorkspaceAppsSettingsSection/);
  assert.doesNotMatch(panelSource, /WorkspaceAgentModelBindingSection/);
});

test("workspace settings makes Custom Agents the third Agent tab", () => {
  const general = panelSource.indexOf('value: "general" as const');
  const runtimes = panelSource.indexOf('value: "agents" as const');
  const customAgents = panelSource.indexOf('value: "customAgents" as const');
  const automation = panelSource.indexOf('value: "automation" as const');

  assert.ok(general >= 0);
  assert.ok(runtimes > general);
  assert.ok(customAgents > runtimes);
  assert.ok(automation > customAgents);
  assert.match(
    panelSource,
    /agentTab === "customAgents"[\s\S]{0,220}<WorkspaceAgentsSection \/>/
  );
  assert.doesNotMatch(runtimeTabSource, /WorkspaceAgentsSection/);
});
