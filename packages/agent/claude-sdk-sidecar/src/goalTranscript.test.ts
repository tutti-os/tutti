import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudeGoalTranscriptPath,
  claudeProjectId,
  ClaudeGoalTranscript
} from "./goalTranscript.ts";

test("goal transcript path mirrors the pinned Claude project key", () => {
  assert.equal(claudeProjectId("/repo with spaces"), "-repo-with-spaces");

  const longCwd = `/${"a".repeat(220)}`;
  assert.equal(claudeProjectId(longCwd), `${`-${"a".repeat(199)}`}-7upm6p`);

  const configDir = join(tmpdir(), "tutti-claude-config");
  const path = claudeGoalTranscriptPath({
    sessionId: "session-1",
    cwd: process.cwd(),
    env: { CLAUDE_CONFIG_DIR: configDir }
  });
  assert.equal(path.startsWith(join(configDir, "projects")), true);
  assert.equal(path.endsWith(join("session-1.jsonl")), true);
});

test("goal transcript skips history and waits for complete JSONL rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutti-goal-transcript-"));
  const path = join(directory, "session.jsonl");
  const observed: Array<Record<string, unknown>> = [];
  const historical = goalStatus("historical", true);
  const current = goalStatus("current", true);
  try {
    await writeFile(path, `${JSON.stringify(historical)}\n`, "utf8");
    const transcript = new ClaudeGoalTranscript((message) => {
      observed.push(message);
    });
    await transcript.start(path);

    await appendFile(
      path,
      `${JSON.stringify({ type: "attachment", attachment: { type: "other" } })}\nnot-json\n${JSON.stringify(current)}`,
      "utf8"
    );
    await transcript.drain();
    assert.deepEqual(observed, []);

    await appendFile(path, "\n", "utf8");
    await transcript.drain();
    await transcript.drain();
    assert.deepEqual(observed, [current]);

    await transcript.close();
    await appendFile(
      path,
      `${JSON.stringify(goalStatus("after close", true))}\n`,
      "utf8"
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(observed, [current]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("goal transcript observes a transcript created after observation starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tutti-goal-transcript-"));
  const path = join(directory, "session.jsonl");
  const observed: Array<Record<string, unknown>> = [];
  const sentinel = goalStatus("created later", false);
  const completed = goalStatus("created later", true);
  const transcript = new ClaudeGoalTranscript((message) => {
    observed.push(message);
  });
  try {
    await transcript.start(path);
    await writeFile(path, `${JSON.stringify(sentinel)}\n`, "utf8");
    await waitFor(() => observed.length === 1);

    await appendFile(path, `${JSON.stringify(completed)}\n`, "utf8");
    await waitFor(() => observed.length === 2);
    assert.deepEqual(observed, [sentinel, completed]);
  } finally {
    await transcript.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function goalStatus(condition: string, met: boolean): Record<string, unknown> {
  return {
    type: "attachment",
    uuid: `goal-${condition}`,
    attachment: {
      type: "goal_status",
      condition,
      met
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail("timed out waiting for transcript observation");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
