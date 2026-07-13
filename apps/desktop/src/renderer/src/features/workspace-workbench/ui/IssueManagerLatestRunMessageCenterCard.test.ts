import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "IssueManagerLatestRunMessageCenterCard.tsx"
  ),
  "utf8"
);

test("issue latest-run card derives message-center decisions from the canonical engine", () => {
  assert.match(source, /getSessionEngine\(workspaceId\)/);
  assert.match(
    source,
    /useEngineSelector\(\s*sessionEngine,\s*selectWorkspaceAgentMessageCenterPresentation/
  );
  assert.match(source, /selectWorkspaceAgentConsumerSession/);
  assert.match(source, /buildWorkspaceAgentMessageCenterModelFromEngine\(/);
  assert.doesNotMatch(source, /buildWorkspaceAgentMessageCenterModel\(/);
});
