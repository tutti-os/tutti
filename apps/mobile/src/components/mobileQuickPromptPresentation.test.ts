import type { AgentQuickPrompt } from "@tutti-os/client-tuttid-ts";
import {
  addMobileQuickPrompt,
  filterMobileQuickPrompts,
  previewMobileQuickPromptContent
} from "./mobileQuickPromptPresentation";

const prompts: AgentQuickPrompt[] = [
  {
    content: "Summarize the current context",
    createdAtUnixMs: 1,
    id: "prompt-1",
    title: "Context",
    updatedAtUnixMs: 2,
    version: 1
  },
  {
    content: "Review risks and gaps",
    createdAtUnixMs: 3,
    id: "prompt-2",
    title: "Review",
    updatedAtUnixMs: 4,
    version: 1
  }
];

describe("mobile quick prompt presentation", () => {
  test("filters titles and content without changing canonical order", () => {
    expect(filterMobileQuickPrompts(prompts, "review")).toEqual([prompts[1]]);
    expect(filterMobileQuickPrompts(prompts, "CURRENT")).toEqual([prompts[0]]);
    expect(filterMobileQuickPrompts(prompts, " ")).toBe(prompts);
  });

  test("adds at the current selection end without replacing existing text", () => {
    expect(
      addMobileQuickPrompt("Before selected after", "prompt", {
        end: 15,
        start: 7
      })
    ).toEqual({
      caret: 21,
      value: "Before selectedprompt after"
    });
  });

  test("appends when no text selection has been observed", () => {
    expect(addMobileQuickPrompt("Before ", "prompt", null)).toEqual({
      caret: 13,
      value: "Before prompt"
    });
  });

  test("compacts and bounds prompt previews", () => {
    expect(previewMobileQuickPromptContent("one\n\n two")).toBe("one two");
    expect(previewMobileQuickPromptContent("x".repeat(120))).toBe(
      `${"x".repeat(95)}…`
    );
  });
});
