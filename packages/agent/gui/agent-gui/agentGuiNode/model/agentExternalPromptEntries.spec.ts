import { describe, expect, it } from "vitest";
import {
  groupAgentExternalPromptEntryInsertions,
  resolveAgentExternalPromptEntries,
  type AgentExternalPromptEntryResolver
} from "./agentExternalPromptEntries";

describe("agentExternalPromptEntries", () => {
  it("preserves source order while separating references from prepared files", () => {
    const files = [
      new File(["a"], "a.txt"),
      new File([], "docs"),
      new File(["b"], "b.txt")
    ];
    const resolver: AgentExternalPromptEntryResolver = () => [
      { sourceIndex: 0, disposition: "prepare" },
      {
        sourceIndex: 1,
        disposition: "reference",
        reference: {
          displayName: "docs",
          kind: "folder",
          path: "/workspace/docs"
        }
      },
      { sourceIndex: 2, disposition: "prepare" }
    ];

    expect(resolveAgentExternalPromptEntries(files, resolver)).toEqual([
      { file: files[0], disposition: "prepare", sourceIndex: 0 },
      {
        disposition: "reference",
        reference: {
          displayName: "docs",
          kind: "folder",
          path: "/workspace/docs"
        },
        sourceIndex: 1
      },
      { file: files[2], disposition: "prepare", sourceIndex: 2 }
    ]);
  });

  it("fails closed to preparation when host resolution is malformed", () => {
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];

    expect(
      resolveAgentExternalPromptEntries(files, () => [
        {
          sourceIndex: 0,
          disposition: "reference",
          reference: { kind: "file", path: "" }
        },
        { sourceIndex: 0, disposition: "prepare" }
      ])
    ).toEqual([
      { file: files[0], disposition: "prepare", sourceIndex: 0 },
      { file: files[1], disposition: "prepare", sourceIndex: 1 }
    ]);
  });

  it("groups only adjacent preparation entries so mixed insertion order stays stable", () => {
    const files = [
      new File(["a"], "a.txt"),
      new File(["b"], "b.txt"),
      new File(["c"], "c.txt")
    ];
    const reference = { kind: "folder" as const, path: "/workspace/docs" };

    expect(
      groupAgentExternalPromptEntryInsertions([
        { disposition: "prepare", file: files[0]!, sourceIndex: 0 },
        { disposition: "prepare", file: files[1]!, sourceIndex: 1 },
        { disposition: "reference", reference, sourceIndex: 2 },
        { disposition: "prepare", file: files[2]!, sourceIndex: 3 }
      ])
    ).toEqual([
      { disposition: "prepare", files: [files[0], files[1]] },
      { disposition: "reference", reference },
      { disposition: "prepare", files: [files[2]] }
    ]);
  });
});
