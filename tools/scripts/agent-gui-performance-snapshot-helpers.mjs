export async function startupWorkspaceID(context) {
  const rows = await context.sqliteJSON(
    context.databasePath,
    `
SELECT id AS workspaceID
FROM workspaces
ORDER BY COALESCE(last_opened_at_unix_ms, 0) DESC,
         updated_at_unix_ms DESC,
         id ASC
LIMIT 1;
`
  );
  const workspaceID = rows[0]?.workspaceID;
  if (!workspaceID) {
    throw new Error("performance snapshot has no startup workspace");
  }
  return workspaceID;
}

export async function updateAgentGUISnapshot(context, updateState) {
  const rows = await context.sqliteJSON(
    context.databasePath,
    `
SELECT workspace_id AS workspaceID, snapshot_json AS snapshotJSON
FROM workspace_workbench_snapshots
WHERE workspace_id = '${sqlString(await startupWorkspaceID(context))}'
LIMIT 1;
`
  );
  const row = rows[0];
  const snapshot = JSON.parse(row?.snapshotJSON ?? "null");
  const node = snapshot?.nodes?.find(
    (candidate) => candidate?.data?.typeId === "agent-gui"
  );
  if (!row?.workspaceID || !node) {
    throw new Error("performance snapshot has no AgentGUI node state");
  }
  node.data.snapshotNodeState = updateState(node.data.snapshotNodeState ?? {});
  await context.sqliteExec(
    context.databasePath,
    `
UPDATE workspace_workbench_snapshots
SET snapshot_json = '${sqlString(JSON.stringify(snapshot))}'
WHERE workspace_id = '${sqlString(row.workspaceID)}';
`
  );
}

export function requiredScenarioData(context, scenarioID) {
  if (!context.scenarioData) {
    throw new Error(`${scenarioID} snapshot preparation did not return data`);
  }
  return context.scenarioData;
}

export function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

export function scenarioSummary(assertions, details, stabilityCriterion) {
  return {
    outcome: assertions.every((assertion) => assertion.passed)
      ? "passed"
      : "failed",
    assertions,
    details,
    stabilityCriterion
  };
}
