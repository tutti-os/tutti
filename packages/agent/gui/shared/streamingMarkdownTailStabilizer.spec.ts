import { describe, expect, it } from "vitest";
import { stabilizeStreamingMarkdownTail } from "./streamingMarkdownTailStabilizer";

describe("stabilizeStreamingMarkdownTail", () => {
  it("leaves completed or non-streaming markdown unchanged", () => {
    const content = "Done\n\n```ts\nconst value = 1;\n```";

    expect(
      stabilizeStreamingMarkdownTail(content, { streaming: false })
    ).toEqual({
      content,
      changed: false
    });
  });

  it("temporarily closes an open fenced code block", () => {
    const result = stabilizeStreamingMarkdownTail(
      "Before\n```ts\nconst value = 1;",
      {
        streaming: true
      }
    );

    expect(result.changed).toBe(true);
    expect(result.reason).toBe("open-fence");
    expect(result.content).toBe("Before\n```ts\nconst value = 1;\n```");
  });

  it("temporarily closes an open inline code span", () => {
    const result = stabilizeStreamingMarkdownTail("Run `pnpm test", {
      streaming: true
    });

    expect(result).toEqual({
      content: "Run `pnpm test`",
      changed: true,
      reason: "open-inline-code"
    });
  });

  it("renders an incomplete tail link as its label text", () => {
    const result = stabilizeStreamingMarkdownTail("Read [README](./READ", {
      streaming: true
    });

    expect(result).toEqual({
      content: "Read README",
      changed: true,
      reason: "incomplete-link-target"
    });
  });

  it("suppresses a dangling list marker at the active tail", () => {
    const result = stabilizeStreamingMarkdownTail("Items\n-", {
      streaming: true
    });

    expect(result).toEqual({
      content: "Items\n",
      changed: true,
      reason: "dangling-list-marker"
    });
  });

  it("soft-closes a partial table row when a table is already underway", () => {
    const result = stabilizeStreamingMarkdownTail(
      "| File | Status |\n| --- | --- |\n| app.ts | pass",
      { streaming: true }
    );

    expect(result).toEqual({
      content: "| File | Status |\n| --- | --- |\n| app.ts | pass |",
      changed: true,
      reason: "partial-table-row"
    });
  });
});
