import { describe, expect, it } from "vitest";
import {
  extractAgentPatchPath,
  inferAgentPatchChangeType,
  normalizeAgentPatchText
} from "./agentPatchMetadata";

describe("agentPatchMetadata", () => {
  it("canonicalizes provider no-newline markers with leading whitespace", () => {
    expect(
      normalizeAgentPatchText(
        "@@ -1 +1 @@\n-old\n \\ No newline at end of file\n+new\n \\ No newline at end of file"
      )
    ).toBe(
      "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file"
    );
  });

  it("extracts metadata from modified git diffs", () => {
    const diffText = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-const ready = false",
      "+const ready = true"
    ].join("\n");

    expect(extractAgentPatchPath(diffText)).toBe("src/a.ts");
    expect(inferAgentPatchChangeType(diffText)).toBe("modified");
  });

  it("extracts metadata from deleted git diffs", () => {
    const deletedDiff = [
      "diff --git a/a.md b/a.md",
      "deleted file mode 100644",
      "--- a/a.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-aaaaa"
    ].join("\n");

    expect(extractAgentPatchPath(deletedDiff)).toBe("a.md");
    expect(inferAgentPatchChangeType(deletedDiff)).toBe("deleted");
  });

  it("extracts metadata from apply_patch patches", () => {
    const deletedPatch = [
      "*** Begin Patch",
      "*** Delete File: a.md",
      "@@",
      "-aaaaa",
      "*** End Patch"
    ].join("\n");

    expect(extractAgentPatchPath(deletedPatch)).toBe("a.md");
    expect(inferAgentPatchChangeType(deletedPatch)).toBe("deleted");
  });

  it("normalizes JSON content wrappers and escaped newlines", () => {
    const wrapped = JSON.stringify({ content: "a\\nb" });

    expect(normalizeAgentPatchText(wrapped)).toBe("a\nb");
  });
});
