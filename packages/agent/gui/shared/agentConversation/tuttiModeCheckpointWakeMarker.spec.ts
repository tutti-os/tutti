import { describe, expect, it } from "vitest";
import {
  TUTTI_MODE_CHECKPOINT_WAKE_MARKER_PREFIX,
  parseTuttiModeCheckpointWake
} from "./tuttiModeCheckpointWakeMarker";

function markerLine(payload: Record<string, unknown>): string {
  return `${TUTTI_MODE_CHECKPOINT_WAKE_MARKER_PREFIX}${JSON.stringify(payload)} -->`;
}

const body =
  "A durable Tutti Mode execution checkpoint requires your review.\n\nIssue: issue-1";

describe("parseTuttiModeCheckpointWake", () => {
  it("parses the marker and strips it from the body", () => {
    const parsed = parseTuttiModeCheckpointWake(
      `${markerLine({
        v: 1,
        kind: "task_settled",
        issueId: "issue-1",
        checkpointId: "checkpoint-1",
        graphRevision: 7
      })}\n\n${body}`
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.marker).toEqual({
      kind: "task_settled",
      issueId: "issue-1",
      checkpointId: "checkpoint-1",
      graphRevision: 7
    });
    // Body keeps the full prompt but drops the sentinel line.
    expect(parsed?.body).toBe(body);
    expect(parsed?.body.includes("TUTTI_MODE_CHECKPOINT_WAKE")).toBe(false);
  });

  it("returns null when there is no marker (legacy message)", () => {
    expect(parseTuttiModeCheckpointWake(body)).toBeNull();
    expect(parseTuttiModeCheckpointWake("")).toBeNull();
    expect(parseTuttiModeCheckpointWake(null)).toBeNull();
  });

  it("does not match a marker that is not the first line", () => {
    const text = `some preamble\n${markerLine({
      v: 1,
      kind: "task_settled"
    })}\n\n${body}`;
    expect(parseTuttiModeCheckpointWake(text)).toBeNull();
  });

  it("degrades to null on malformed JSON or a missing kind", () => {
    expect(
      parseTuttiModeCheckpointWake(
        `${TUTTI_MODE_CHECKPOINT_WAKE_MARKER_PREFIX}{not json} -->\n\n${body}`
      )
    ).toBeNull();
    expect(
      parseTuttiModeCheckpointWake(`${markerLine({ v: 1 })}\n\n${body}`)
    ).toBeNull();
  });

  it("tolerates a missing graph revision", () => {
    const parsed = parseTuttiModeCheckpointWake(
      `${markerLine({
        v: 1,
        kind: "all_tasks_terminal",
        issueId: "issue-9",
        checkpointId: "checkpoint-9"
      })}\n\n${body}`
    );
    expect(parsed?.marker.graphRevision).toBeNull();
    expect(parsed?.marker.kind).toBe("all_tasks_terminal");
  });
});
