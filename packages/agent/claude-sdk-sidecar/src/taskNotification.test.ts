import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskNotification,
  readQueuedTaskNotificationPrompt,
  readUserMessageNotificationText,
  taskNotificationToSystemMessage
} from "./taskNotification.ts";

test("parseTaskNotification extracts fold-in task notification fields", () => {
  const parsed = parseTaskNotification(`<task-notification>
<task-id>a12d5359ec75cda9d</task-id>
<tool-use-id>call_9c651fe8b89a49f9b4f56eba</tool-use-id>
<output-file>/tmp/agent.output</output-file>
<status>completed</status>
<summary>Agent "Generate random number 2" finished</summary>
<result>7</result>
<usage><subagent_tokens>0</subagent_tokens><tool_uses>0</tool_uses><duration_ms>1282</duration_ms></usage>
</task-notification>`);

  assert.ok(parsed);
  assert.equal(parsed?.taskId, "a12d5359ec75cda9d");
  assert.equal(parsed?.toolUseId, "call_9c651fe8b89a49f9b4f56eba");
  assert.equal(parsed?.status, "completed");
  assert.equal(parsed?.result, "7");
  assert.equal(parsed?.usage?.duration_ms, 1282);
});

test("taskNotificationToSystemMessage maps tool use id for delegated task lookup", () => {
  const parsed = parseTaskNotification(`<task-notification>
<task-id>agent-1</task-id>
<tool-use-id>toolu-agent</tool-use-id>
<status>completed</status>
<summary>Done</summary>
</task-notification>`);
  assert.ok(parsed);
  const message = taskNotificationToSystemMessage(parsed!);
  assert.equal(message.tool_use_id, "toolu-agent");
  assert.equal(message.task_id, "agent-1");
  assert.equal(message.status, "completed");
});

test("readUserMessageNotificationText supports string user content", () => {
  const text = readUserMessageNotificationText({
    message: {
      content:
        "<task-notification><tool-use-id>toolu-agent</tool-use-id><status>completed</status></task-notification>"
    }
  });
  assert.match(text, /<task-notification>/);
});

test("readQueuedTaskNotificationPrompt reads fold-in attachment prompt", () => {
  const prompt = readQueuedTaskNotificationPrompt({
    attachment: {
      type: "queued_command",
      commandMode: "task-notification",
      prompt:
        "<task-notification><tool-use-id>toolu-agent</tool-use-id><status>completed</status><summary>Done</summary></task-notification>"
    }
  });
  assert.match(prompt, /<tool-use-id>toolu-agent<\/tool-use-id>/);
});
